// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SigilSelfWallet
/// @notice A wallet an AI self can use, only within rules its owner sets.
/// @dev Two keys. The owner can do anything at any time: change the rules, freeze,
///      withdraw, call any contract. The self key (derived on the owner's device from
///      the vault key) can only make calls that pass every rule:
///        - the wallet is not frozen and the rules have not expired
///        - a call with no data (a plain payment) goes only to a listed recipient
///        - a call with data goes only to a listed contract, with a function selector
///          allowed for that contract
///        - native value stays within the cap per transaction and per day
///        - an ERC-20 transfer or approve names a listed recipient (never a contract or
///          token on the contract list) and stays within that token's caps;
///          transferFrom and allowance increases are refused
///        - on a token that has caps, transfer and approve are the only calls: any other
///          function of it (transferAndCall, send, safeTransferFrom, ...) is refused, so
///          nothing moves that token around its caps. A token whose caps are set to zero
///          is blocked: no call to it goes through at all
///        - a token transfer or approve counts only when the token says it succeeded: a
///          token that returns false, or has no code, fails the whole call
///      Recipients and contracts are two lists, and no address is on both: a contract
///      the self may call (a router, a token) can never be paid by the self key, so
///      nothing it pays can be swept out of a contract by someone else.
///      The caps count what the self key moves itself. A listed contract's function
///      arguments are not read: a function that pays out (a router's swap, say) can send
///      what the self pays it, within the caps, to any address its arguments name.
///      An allowance the owner gave to a listed contract is the owner's own decision: a
///      call to that contract that spends it is not counted against the token's caps.
///      Allowances the self key gives (only ever to recipients) are recorded; freezing
///      the wallet sets each of them back to zero, and so does revokeApprovals.
///      The self key can send a call itself, or sign it (EIP-712) for anyone to submit,
///      so it never needs gas of its own. A signed call names the gas its inner call
///      gets; a submitter who sends too little for that cannot make it run short. Replacing the rules with `configure` starts a
///      new rule set: nothing from the old one carries over. A signed call is checked
///      against the rules in force when it is sent, never those it was signed under; the
///      owner can cancel every signed call not yet sent with `cancelSignedCalls`, and
///      unfreezing and changing the self key cancel them too. Cancelling moves the nonce
///      past every call that could have been signed ahead, so none of them can come back. Spending per day is counted
///      per UTC calendar day (00:00 to 24:00 UTC), not over a rolling 24 hours, and is not
///      reset by new rules.
///      The same EIP-712 digest is computed in packages/core/src/identity.ts.
contract SigilSelfWallet {
    struct SelectorRule {
        address target;
        bytes4 selector;
    }

    struct TokenLimit {
        address token;
        uint128 perTx;
        uint128 perDay;
    }

    struct Spend {
        uint64 day;
        uint192 spent;
    }

    bytes32 public constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant EXECUTE_TYPEHASH = keccak256("Execute(address target,uint256 value,bytes data,uint256 nonce,uint256 deadline,uint256 gas)");
    bytes32 private constant NAME_HASH = keccak256("SigilSelfWallet");
    bytes32 private constant VERSION_HASH = keccak256("2");
    /// @notice At most this many allowances the self key gave can be open at once.
    uint256 public constant MAX_OPEN_APPROVALS = 16;
    /// @dev Gas given to each token when an allowance is set back to zero, so one token cannot stop a freeze.
    uint256 private constant REVOKE_GAS = 100_000;
    /// @dev How far a cancel moves the nonce: further than any call could have been signed ahead.
    uint256 public constant SIGNED_WINDOW = 1 << 64;
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    bytes4 private constant TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 private constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 private constant TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)
    bytes4 private constant INCREASE_ALLOWANCE = 0x39509351; // increaseAllowance(address,uint256)
    bytes4 private constant PERMIT = 0xd505accf; // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)

    address public owner;
    address public selfKey;
    bool public frozen;
    /// @notice Native value the self key may send in one call, and in one UTC day.
    uint256 public perTxCap;
    uint256 public perDayCap;
    /// @notice After this time the self key can do nothing until the owner sets new rules. Zero means no end.
    uint64 public expiresAt;
    /// @notice Starts at 1 and goes up with every `configure`; lists of an older rule set no longer count.
    uint256 public rulesVersion;
    /// @notice Used by signed calls; goes up by one with every call the self key makes, and jumps
    ///         by SIGNED_WINDOW when signed calls are cancelled (cancelSignedCalls, unfreeze, setSelfKey).
    uint256 public nonce;

    Spend private _native;
    mapping(address token => Spend) private _tokenSpend;
    mapping(uint256 version => mapping(address target => bool)) private _targets;
    mapping(uint256 version => mapping(address recipient => bool)) private _recipients;
    mapping(uint256 version => mapping(address target => mapping(bytes4 selector => bool))) private _selectors;
    mapping(uint256 version => mapping(address token => TokenLimit)) private _tokenLimits;

    /// @notice An allowance the self key gave and that may still be open.
    struct Approval {
        address token;
        address spender;
    }

    Approval[] private _approvals;
    mapping(address token => mapping(address spender => bool)) private _approvalListed;

    event Executed(uint256 indexed nonce, address indexed target, uint256 value, bytes4 selector, address tokenTo, uint256 tokenAmount);
    event OwnerExecuted(address indexed target, uint256 value, bytes4 selector);
    event Configured(uint256 indexed version, uint256 perTxCap, uint256 perDayCap, uint64 expiresAt);
    event LimitsChanged(uint256 perTxCap, uint256 perDayCap, uint64 expiresAt);
    event TargetChanged(address indexed target, bool allowed);
    event RecipientChanged(address indexed recipient, bool allowed);
    event ApprovalRevoked(address indexed token, address indexed spender, bool ok);
    event SelectorChanged(address indexed target, bytes4 selector, bool allowed);
    event TokenLimitChanged(address indexed token, uint128 perTx, uint128 perDay);
    event FrozenChanged(bool frozen, address by);
    event SelfKeyChanged(address indexed previousKey, address indexed newKey);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Received(address indexed from, uint256 amount);
    event SignedCallsCancelled(uint256 nonce);

    error NotOwner();
    error NotSelf();
    error NotOwnerOrSelf();
    error ZeroAddress();
    error IsFrozen();
    error RulesExpired();
    error Expired();
    error BadSignature();
    error TargetNotAllowed(address target);
    error SelectorNotAllowed(address target, bytes4 selector);
    error TokenNotAllowed(address token);
    error RecipientNotAllowed(address to);
    error TokenMoveRefused(bytes4 selector);
    error OverTxCap(uint256 amount, uint256 cap);
    error OverDayCap(uint256 spent, uint256 cap);
    error CallFailed(bytes reason);
    error RecipientAndContract(address account);
    error TooManyOpenApprovals();
    error NotEnoughGas();
    error TokenCallRefused(address token, bytes ret);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address selfKey_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        selfKey = selfKey_;
        rulesVersion = 1;
        emit OwnershipTransferred(address(0), owner_);
        emit SelfKeyChanged(address(0), selfKey_);
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ the self key

    /// @notice A call made by the self key itself, within the rules.
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory) {
        if (msg.sender != selfKey || selfKey == address(0)) revert NotSelf();
        return _selfCall(target, value, data, 0);
    }

    /// @notice A call the self key signed, submitted by anyone, within the rules.
    /// @param gas The gas the inner call gets, as signed. Zero: all the gas that is left.
    function executeWithSig(address target, uint256 value, bytes calldata data, uint256 deadline, uint256 gas, bytes calldata signature) external returns (bytes memory) {
        if (block.timestamp > deadline) revert Expired();
        if (selfKey == address(0) || _recover(executeDigest(target, value, data, nonce, deadline, gas), signature) != selfKey) revert BadSignature();
        return _selfCall(target, value, data, gas);
    }

    /// @notice Stops the self key at once, and sets every allowance it gave back to zero.
    ///         The owner and the self key can both freeze; only the owner can unfreeze.
    function freeze() external {
        if (msg.sender != owner && msg.sender != selfKey) revert NotOwnerOrSelf();
        frozen = true;
        emit FrozenChanged(true, msg.sender);
        // A freeze always lands, even with little gas; the allowances it had no gas for stay
        // listed in openApprovals(), and revokeApprovals() clears them or reverts.
        _revokeApprovals(false);
    }

    /// @notice Sets every allowance the self key gave back to zero. The owner or the self key.
    ///         An allowance a token refuses to reset stays listed. Reverts with NotEnoughGas
    ///         rather than stop part way, so a call that succeeds has tried every allowance.
    function revokeApprovals() external {
        if (msg.sender != owner && msg.sender != selfKey) revert NotOwnerOrSelf();
        _revokeApprovals(true);
    }

    // ------------------------------------------------------------------ the owner

    function unfreeze() external onlyOwner {
        frozen = false;
        // A call signed before the freeze does not go through after it.
        _cancelSigned();
        emit FrozenChanged(false, msg.sender);
    }

    /// @notice Cancels every call the self key signed and nobody has sent yet.
    function cancelSignedCalls() external onlyOwner {
        _cancelSigned();
    }

    /// @notice Replaces every rule at once: caps, expiry, recipients, contracts, selectors and token limits.
    /// @param recipients Who the self key may pay: native value and token transfers and approvals.
    /// @param targets The contracts the self key may call (tokens included). Never also a recipient.
    function configure(uint256 perTxCap_, uint256 perDayCap_, uint64 expiresAt_, address[] calldata recipients, address[] calldata targets, SelectorRule[] calldata selectors, TokenLimit[] calldata tokens) external onlyOwner {
        uint256 v = rulesVersion + 1;
        rulesVersion = v;
        perTxCap = perTxCap_;
        perDayCap = perDayCap_;
        expiresAt = expiresAt_;
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == address(0)) revert ZeroAddress();
            _recipients[v][recipients[i]] = true;
        }
        for (uint256 i = 0; i < targets.length; i++) {
            if (targets[i] == address(0)) revert ZeroAddress();
            if (_recipients[v][targets[i]]) revert RecipientAndContract(targets[i]);
            _targets[v][targets[i]] = true;
        }
        for (uint256 i = 0; i < selectors.length; i++) {
            _selectors[v][selectors[i].target][selectors[i].selector] = true;
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i].token == address(0)) revert ZeroAddress();
            _tokenLimits[v][tokens[i].token] = tokens[i];
        }
        emit Configured(v, perTxCap_, perDayCap_, expiresAt_);
    }

    function setLimits(uint256 perTxCap_, uint256 perDayCap_, uint64 expiresAt_) external onlyOwner {
        perTxCap = perTxCap_;
        perDayCap = perDayCap_;
        expiresAt = expiresAt_;
        emit LimitsChanged(perTxCap_, perDayCap_, expiresAt_);
    }

    function setTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        if (allowed && _recipients[rulesVersion][target]) revert RecipientAndContract(target);
        _targets[rulesVersion][target] = allowed;
        emit TargetChanged(target, allowed);
    }

    function setRecipient(address recipient, bool allowed) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        if (allowed && _targets[rulesVersion][recipient]) revert RecipientAndContract(recipient);
        _recipients[rulesVersion][recipient] = allowed;
        emit RecipientChanged(recipient, allowed);
    }

    function setSelector(address target, bytes4 selector, bool allowed) external onlyOwner {
        _selectors[rulesVersion][target][selector] = allowed;
        emit SelectorChanged(target, selector, allowed);
    }

    /// @notice Caps for a token. Zero caps block it: no transfer, approve or other call of it goes through.
    function setTokenLimit(address token, uint128 perTx, uint128 perDay) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        _tokenLimits[rulesVersion][token] = TokenLimit({token: token, perTx: perTx, perDay: perDay});
        emit TokenLimitChanged(token, perTx, perDay);
    }

    /// @notice Moves the wallet to a new self key. Zero leaves it with none: only the owner can act.
    ///         Every call signed before, by any key, is cancelled: switching back to an
    ///         earlier key never brings its old signatures back.
    function setSelfKey(address newKey) external onlyOwner {
        emit SelfKeyChanged(selfKey, newKey);
        selfKey = newKey;
        _cancelSigned();
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, bytes memory ret) = to.call{value: amount}("");
        if (!ok) revert CallFailed(ret);
        emit Withdrawn(address(0), to, amount);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(TRANSFER, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert CallFailed(ret);
        emit Withdrawn(token, to, amount);
    }

    /// @notice The owner may call anything, with no rule in the way.
    function ownerExecute(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit OwnerExecuted(target, value, data.length >= 4 ? bytes4(data[0:4]) : bytes4(0));
        return ret;
    }

    // ------------------------------------------------------------------ reads

    function isTargetAllowed(address target) external view returns (bool) {
        return _targets[rulesVersion][target];
    }

    function isRecipient(address recipient) external view returns (bool) {
        return _recipients[rulesVersion][recipient];
    }

    /// @notice The allowances the self key gave that may still be open (token, spender).
    function openApprovals() external view returns (Approval[] memory) {
        return _approvals;
    }

    function isSelectorAllowed(address target, bytes4 selector) external view returns (bool) {
        return _selectors[rulesVersion][target][selector];
    }

    function tokenLimit(address token) external view returns (uint128 perTx, uint128 perDay) {
        TokenLimit storage t = _tokenLimits[rulesVersion][token];
        return (t.perTx, t.perDay);
    }

    /// @notice Native value the self key may still send today.
    function remainingToday() external view returns (uint256) {
        uint256 spent = _native.day == _today() ? _native.spent : 0;
        return spent >= perDayCap ? 0 : perDayCap - spent;
    }

    function tokenRemainingToday(address token) external view returns (uint256) {
        Spend storage s = _tokenSpend[token];
        uint256 spent = s.day == _today() ? s.spent : 0;
        uint256 cap = _tokenLimits[rulesVersion][token].perDay;
        return spent >= cap ? 0 : cap - spent;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function executeDigest(address target, uint256 value, bytes calldata data, uint256 nonce_, uint256 deadline, uint256 gas) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(EXECUTE_TYPEHASH, target, value, keccak256(data), nonce_, deadline, gas));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    // ------------------------------------------------------------------ internal

    function _selfCall(address target, uint256 value, bytes calldata data, uint256 gas) private returns (bytes memory) {
        if (frozen) revert IsFrozen();
        if (expiresAt != 0 && block.timestamp >= expiresAt) revert RulesExpired();
        uint256 v = rulesVersion;
        if (target == address(this)) revert TargetNotAllowed(target);

        bytes4 selector;
        address tokenTo;
        uint256 tokenAmount;
        if (data.length == 0) {
            // A plain payment, or a call with no data at all: only to a recipient, never to a
            // contract's receive or fallback.
            if (!_recipients[v][target]) revert RecipientNotAllowed(target);
        } else {
            if (!_targets[v][target]) revert TargetNotAllowed(target);
            if (data.length < 4) revert SelectorNotAllowed(target, bytes4(0));
            selector = bytes4(data[0:4]);
            if (!_selectors[v][target][selector]) revert SelectorNotAllowed(target, selector);
            // A token with an entry in the limits (even one set to zero, which blocks it) takes
            // transfer and approve only, and those within its caps.
            if (_tokenLimits[v][target].token == target && selector != TRANSFER && selector != APPROVE) {
                revert TokenMoveRefused(selector);
            }
            if (selector == TRANSFER || selector == APPROVE) {
                (tokenTo, tokenAmount) = abi.decode(data[4:], (address, uint256));
                _spendToken(v, target, tokenTo, tokenAmount);
                if (selector == APPROVE) _noteApproval(target, tokenTo, tokenAmount);
            } else if (selector == TRANSFER_FROM || selector == INCREASE_ALLOWANCE || selector == PERMIT) {
                revert TokenMoveRefused(selector);
            }
        }
        if (value > 0) {
            if (value > perTxCap) revert OverTxCap(value, perTxCap);
            _native = _spend(_native, value, perDayCap);
        }

        uint256 n = nonce;
        unchecked {
            nonce = n + 1;
        }
        bool ok;
        bytes memory ret;
        if (gas == 0) {
            (ok, ret) = target.call{value: value}(data);
        } else {
            // The call must get the gas the self key signed for. A call only ever gets 63/64 of
            // what is left, after the cost of sending value and copying the data; the margin
            // covers that cost. With less, the whole call reverts and the nonce is not spent.
            if (gasleft() < gas + gas / 63 + 40_000 + data.length * 2) revert NotEnoughGas();
            (ok, ret) = target.call{value: value, gas: gas}(data);
        }
        if (!ok) revert CallFailed(ret);
        // A token transfer or approve counts only when the token says so: no code, a short
        // answer or false fails the call, and nothing is counted as spent or approved.
        if (selector == TRANSFER || selector == APPROVE) {
            if (target.code.length == 0) revert TokenCallRefused(target, ret);
            if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) != 1)) {
                revert TokenCallRefused(target, ret);
            }
        }
        emit Executed(n, target, value, selector, tokenTo, tokenAmount);
        return ret;
    }

    function _noteApproval(address token, address spender, uint256 amount) private {
        bool listed = _approvalListed[token][spender];
        if (amount != 0 && !listed) {
            if (_approvals.length >= MAX_OPEN_APPROVALS) revert TooManyOpenApprovals();
            _approvals.push(Approval({token: token, spender: spender}));
            _approvalListed[token][spender] = true;
        } else if (amount == 0 && listed) {
            _dropApproval(token, spender);
        }
    }

    function _dropApproval(address token, address spender) private {
        uint256 n = _approvals.length;
        for (uint256 i = 0; i < n; i++) {
            if (_approvals[i].token == token && _approvals[i].spender == spender) {
                _approvals[i] = _approvals[n - 1];
                _approvals.pop();
                break;
            }
        }
        _approvalListed[token][spender] = false;
    }

    /// @dev Sets each listed allowance to zero with a bounded amount of gas and without copying
    ///      more than one word back, so no token can make it fail. One that refuses stays listed.
    ///      strict: revert when the gas runs out instead of stopping with allowances left untried.
    function _revokeApprovals(bool strict) private {
        uint256 i = _approvals.length;
        while (i > 0) {
            i--;
            if (gasleft() < REVOKE_GAS + 30_000) {
                if (strict) revert NotEnoughGas();
                break;
            }
            Approval memory a = _approvals[i];
            bytes memory call_ = abi.encodeWithSelector(APPROVE, a.spender, uint256(0));
            address token = a.token;
            uint256 g = REVOKE_GAS;
            bool ok;
            assembly ("memory-safe") {
                mstore(0x00, 0)
                ok := call(g, token, 0, add(call_, 0x20), mload(call_), 0x00, 0x20)
                // A token that returns nothing is fine; one that returns a word must return true.
                if and(ok, gt(returndatasize(), 0)) {
                    ok := and(iszero(lt(returndatasize(), 0x20)), iszero(iszero(mload(0x00))))
                }
            }
            if (ok) {
                _approvals[i] = _approvals[_approvals.length - 1];
                _approvals.pop();
                _approvalListed[token][a.spender] = false;
            }
            emit ApprovalRevoked(token, a.spender, ok);
        }
    }

    function _cancelSigned() private {
        uint256 n = nonce + SIGNED_WINDOW;
        nonce = n;
        emit SignedCallsCancelled(n);
    }

    function _spendToken(uint256 v, address token, address to, uint256 amount) private {
        TokenLimit storage limit = _tokenLimits[v][token];
        if (limit.perTx == 0) revert TokenNotAllowed(token);
        // Tokens go, and allowances are given, only to recipients: never to a listed contract or
        // token, which anyone might be able to sweep. To let the self trade through a router,
        // the owner gives the router an allowance with ownerExecute.
        if (!_recipients[v][to]) revert RecipientNotAllowed(to);
        if (amount > limit.perTx) revert OverTxCap(amount, limit.perTx);
        _tokenSpend[token] = _spend(_tokenSpend[token], amount, limit.perDay);
    }

    function _spend(Spend memory s, uint256 amount, uint256 cap) private view returns (Spend memory) {
        uint64 day = _today();
        uint256 spent = (s.day == day ? s.spent : 0) + amount;
        if (spent > cap || spent > type(uint192).max) revert OverDayCap(spent, cap);
        return Spend({day: day, spent: uint192(spent)});
    }

    function _today() private view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        if (uint256(s) > HALF_N) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
