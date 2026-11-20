// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SigilSelfWallet
/// @notice A wallet an AI self can use, only within rules its owner sets.
/// @dev Two keys. The owner can do anything at any time: change the rules, freeze,
///      withdraw, call any contract. The self key (derived on the owner's device from
///      the vault key) can only make calls that pass every rule:
///        - the wallet is not frozen and the rules have not expired
///        - the target is on the allowed list (recipients and contracts alike)
///        - a call with data uses a function selector allowed for that target
///        - native value stays within the cap per transaction and per day
///        - an ERC-20 transfer or approve names an allowed recipient or spender and
///          stays within that token's caps; transferFrom and allowance increases are refused
///      The self key can send a call itself, or sign it (EIP-712) for anyone to submit,
///      so it never needs gas of its own. Replacing the rules with `configure` starts a
///      new rule set: nothing from the old one carries over. Spending per day is counted
///      in whole UTC days and is not reset by new rules.
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

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant EXECUTE_TYPEHASH =
        keccak256("Execute(address target,uint256 value,bytes data,uint256 nonce,uint256 deadline)");
    bytes32 private constant NAME_HASH = keccak256("SigilSelfWallet");
    bytes32 private constant VERSION_HASH = keccak256("1");
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
    /// @notice Used by signed calls; goes up with every call the self key makes.
    uint256 public nonce;

    Spend private _native;
    mapping(address token => Spend) private _tokenSpend;
    mapping(uint256 version => mapping(address target => bool)) private _targets;
    mapping(uint256 version => mapping(address target => mapping(bytes4 selector => bool))) private _selectors;
    mapping(uint256 version => mapping(address token => TokenLimit)) private _tokenLimits;

    event Executed(uint256 indexed nonce, address indexed target, uint256 value, bytes4 selector, address tokenTo, uint256 tokenAmount);
    event OwnerExecuted(address indexed target, uint256 value, bytes4 selector);
    event Configured(uint256 indexed version, uint256 perTxCap, uint256 perDayCap, uint64 expiresAt);
    event LimitsChanged(uint256 perTxCap, uint256 perDayCap, uint64 expiresAt);
    event TargetChanged(address indexed target, bool allowed);
    event SelectorChanged(address indexed target, bytes4 selector, bool allowed);
    event TokenLimitChanged(address indexed token, uint128 perTx, uint128 perDay);
    event FrozenChanged(bool frozen, address by);
    event SelfKeyChanged(address indexed previousKey, address indexed newKey);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Received(address indexed from, uint256 amount);

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
        return _selfCall(target, value, data);
    }

    /// @notice A call the self key signed, submitted by anyone, within the rules.
    function executeWithSig(address target, uint256 value, bytes calldata data, uint256 deadline, bytes calldata signature) external returns (bytes memory) {
        if (block.timestamp > deadline) revert Expired();
        if (selfKey == address(0) || _recover(executeDigest(target, value, data, nonce, deadline), signature) != selfKey) revert BadSignature();
        return _selfCall(target, value, data);
    }

    /// @notice Stops the self key at once. The owner and the self key can both freeze; only the owner can unfreeze.
    function freeze() external {
        if (msg.sender != owner && msg.sender != selfKey) revert NotOwnerOrSelf();
        frozen = true;
        emit FrozenChanged(true, msg.sender);
    }

    // ------------------------------------------------------------------ the owner

    function unfreeze() external onlyOwner {
        frozen = false;
        emit FrozenChanged(false, msg.sender);
    }

    /// @notice Replaces every rule at once: caps, expiry, allowed targets, selectors and token limits.
    function configure(
        uint256 perTxCap_,
        uint256 perDayCap_,
        uint64 expiresAt_,
        address[] calldata targets,
        SelectorRule[] calldata selectors,
        TokenLimit[] calldata tokens
    ) external onlyOwner {
        uint256 v = rulesVersion + 1;
        rulesVersion = v;
        perTxCap = perTxCap_;
        perDayCap = perDayCap_;
        expiresAt = expiresAt_;
        for (uint256 i = 0; i < targets.length; i++) {
            if (targets[i] == address(0)) revert ZeroAddress();
            _targets[v][targets[i]] = true;
        }
        for (uint256 i = 0; i < selectors.length; i++) {
            _selectors[v][selectors[i].target][selectors[i].selector] = true;
        }
        for (uint256 i = 0; i < tokens.length; i++) {
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
        _targets[rulesVersion][target] = allowed;
        emit TargetChanged(target, allowed);
    }

    function setSelector(address target, bytes4 selector, bool allowed) external onlyOwner {
        _selectors[rulesVersion][target][selector] = allowed;
        emit SelectorChanged(target, selector, allowed);
    }

    function setTokenLimit(address token, uint128 perTx, uint128 perDay) external onlyOwner {
        _tokenLimits[rulesVersion][token] = TokenLimit({token: token, perTx: perTx, perDay: perDay});
        emit TokenLimitChanged(token, perTx, perDay);
    }

    /// @notice Moves the wallet to a new self key. Zero leaves it with none: only the owner can act.
    function setSelfKey(address newKey) external onlyOwner {
        emit SelfKeyChanged(selfKey, newKey);
        selfKey = newKey;
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

    function executeDigest(address target, uint256 value, bytes calldata data, uint256 nonce_, uint256 deadline) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(EXECUTE_TYPEHASH, target, value, keccak256(data), nonce_, deadline));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    // ------------------------------------------------------------------ internal

    function _selfCall(address target, uint256 value, bytes calldata data) private returns (bytes memory) {
        if (frozen) revert IsFrozen();
        if (expiresAt != 0 && block.timestamp >= expiresAt) revert RulesExpired();
        uint256 v = rulesVersion;
        if (target == address(this) || !_targets[v][target]) revert TargetNotAllowed(target);

        bytes4 selector;
        address tokenTo;
        uint256 tokenAmount;
        if (data.length > 0) {
            if (data.length < 4) revert SelectorNotAllowed(target, bytes4(0));
            selector = bytes4(data[0:4]);
            if (!_selectors[v][target][selector]) revert SelectorNotAllowed(target, selector);
            if (selector == TRANSFER || selector == APPROVE) {
                (tokenTo, tokenAmount) = abi.decode(data[4:], (address, uint256));
                _spendToken(v, target, tokenTo, tokenAmount);
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
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit Executed(n, target, value, selector, tokenTo, tokenAmount);
        return ret;
    }

    function _spendToken(uint256 v, address token, address to, uint256 amount) private {
        TokenLimit storage limit = _tokenLimits[v][token];
        if (limit.perTx == 0) revert TokenNotAllowed(token);
        if (!_targets[v][to]) revert RecipientNotAllowed(to);
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
