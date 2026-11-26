// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SigilSelfWallet} from "../src/SigilSelfWallet.sol";
import {SigilSelfRegistry} from "../src/SigilSelfRegistry.sol";

// The proofs of the HeyResearch security review (GHSA-fqh9-xcrq-cgpg, review of 7ee22a6),
// adapted to the fixed contracts so each now shows its fix. The review ran them on a fork of
// Robinhood Chain against USDG (6 decimals) and Uniswap's UniversalRouter. Here the same shapes
// run on local stand-ins by default, so the suite needs no network. With SIGIL_REVIEW_FORK_RPC set
// to a Robinhood Chain RPC, setUp forks it and the same tests run against the real USDG and router.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// A 6-decimal token like USDG.
contract SixDecimalToken {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// The two UniversalRouter commands the review used: SWEEP (anyone takes the router's balance
/// of a token) and WRAP_ETH (value sent in goes to any recipient as wrapped ether).
contract RouterStandIn {
    SixDecimalToken public immutable weth = new SixDecimalToken();

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256) external payable {
        for (uint256 i = 0; i < commands.length; i++) {
            if (commands[i] == 0x04) {
                (address token, address to,) = abi.decode(inputs[i], (address, address, uint160));
                IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
            } else if (commands[i] == 0x0b) {
                (address to, uint256 amount) = abi.decode(inputs[i], (address, uint256));
                weth.mint(to, amount);
            }
        }
    }
}

/// A forwarder that pays out whatever it holds to whoever set it, on an empty call (I-2).
contract EmptyCallForwarder {
    address public payee;
    uint256 public runs;

    constructor(address payee_) {
        payee = payee_;
    }

    fallback() external payable {
        runs++;
    }
}

/// A target that catches an inner failure and still returns success (I-4).
contract Catcher {
    uint256[24] private _slots;

    function heavy() external {
        for (uint256 i = 0; i < 20; i++) _slots[i] = block.number + i + 1;
    }

    function work() external returns (bool full) {
        try this.heavy() {
            return true;
        } catch {
            return false;
        }
    }
}

/// Tokens that behave badly when an allowance is set back to zero.
contract RevertingToken {
    mapping(address => mapping(address => uint256)) public allowance;
    bool public stuck;

    function setStuck(bool v) external {
        stuck = v;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(!stuck, "no");
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract GasBurningToken {
    mapping(address => mapping(address => uint256)) public allowance;
    bool public burn;

    function setBurn(bool v) external {
        burn = v;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (burn) {
            while (true) {}
        }
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract ReturnBombToken {
    mapping(address => mapping(address => uint256)) public allowance;
    bool public bomb;

    function setBomb(bool v) external {
        bomb = v;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        if (bomb) {
            assembly {
                mstore(0, 1)
                return(0, 100000)
            }
        }
        return true;
    }
}

contract SigilReviewTest is Test {
    // Robinhood Chain, as the review forked it.
    address constant FORK_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant FORK_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address constant FORK_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    bytes1 constant CMD_SWEEP = 0x04;
    bytes1 constant CMD_WRAP_ETH = 0x0b;

    address usdg;
    address router;
    address weth;
    bool forked;

    uint256 ownerPk = 0xA11CE;
    uint256 selfPk = 0x5E1F;
    address owner;
    address selfKey;
    address friend = address(0x1111111111111111111111111111111111111111); // the one listed recipient
    address attacker = makeAddr("attacker"); // listed nowhere

    function setUp() public {
        owner = vm.addr(ownerPk);
        selfKey = vm.addr(selfPk);
        string memory rpc = vm.envOr("SIGIL_REVIEW_FORK_RPC", string(""));
        if (bytes(rpc).length > 0) {
            vm.createSelectFork(rpc);
            usdg = FORK_USDG;
            router = FORK_ROUTER;
            weth = FORK_WETH;
            forked = true;
        } else {
            vm.warp(1_800_000_000);
            usdg = address(new SixDecimalToken());
            RouterStandIn r = new RouterStandIn();
            router = address(r);
            weth = address(r.weth());
        }
    }

    function _deal(address token, address to, uint256 amount) internal {
        if (forked) deal(token, to, amount);
        else SixDecimalToken(token).mint(to, amount);
    }

    /// The configure() arguments the fixed vault builds for: one recipient, the router as a
    /// contract with execute(), and USDG with caps of 50 and 50 in the decimals the token answers.
    function _configureLikeTheVault(SigilSelfWallet w, uint256 nativePerTx, uint256 nativePerDay) internal {
        uint128 cap = uint128(50 * 10 ** IERC20(usdg).decimals());
        address[] memory recipients = new address[](1);
        recipients[0] = friend;
        address[] memory targets = new address[](2);
        targets[0] = router;
        targets[1] = usdg;
        SigilSelfWallet.SelectorRule[] memory sels = new SigilSelfWallet.SelectorRule[](3);
        sels[0] = SigilSelfWallet.SelectorRule(router, IUniversalRouter.execute.selector);
        sels[1] = SigilSelfWallet.SelectorRule(usdg, bytes4(0xa9059cbb));
        sels[2] = SigilSelfWallet.SelectorRule(usdg, bytes4(0x095ea7b3));
        SigilSelfWallet.TokenLimit[] memory toks = new SigilSelfWallet.TokenLimit[](1);
        toks[0] = SigilSelfWallet.TokenLimit(usdg, cap, cap);
        vm.prank(owner);
        w.configure(nativePerTx, nativePerDay, 0, recipients, targets, sels, toks);
    }

    function _fundedWallet() internal returns (SigilSelfWallet w) {
        w = new SigilSelfWallet(owner, selfKey);
        _deal(usdg, address(w), 500e6);
        vm.deal(address(w), 1 ether);
    }

    function _sweep(address token, address to) internal {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(token, to, uint160(0));
        IUniversalRouter(router).execute(abi.encodePacked(CMD_SWEEP), inputs, block.timestamp + 60);
    }

    // ------------------------------------------------------------------ M-1

    /// Fixed in the vault: decimals are read from the token, never defaulted to 18. With the caps
    /// the vault now builds, "50 USDG" is 50e6 base units on chain and the whole balance cannot move.
    function test_M1_capsInTheTokensOwnDecimalsHold() public {
        assertEq(IERC20(usdg).decimals(), 6);
        SigilSelfWallet w = _fundedWallet();
        _configureLikeTheVault(w, 0, 0);
        (uint128 perTx, uint128 perDay) = w.tokenLimit(usdg);
        assertEq(perTx, 50e6);
        assertEq(perDay, 50e6);
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverTxCap.selector, 500e6, 50e6));
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.transfer.selector, friend, 500e6));
        // 60 is refused on chain exactly as "Try a payment" refuses it in the vault.
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverTxCap.selector, 60e6, 50e6));
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.transfer.selector, friend, 60e6));
        vm.prank(selfKey);
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.transfer.selector, friend, 50e6));
        assertEq(IERC20(usdg).balanceOf(address(w)), 450e6);
        assertEq(w.tokenRemainingToday(usdg), 0);
    }

    // ------------------------------------------------------------------ L-1

    /// Fixed: recipients are their own list. A listed router or token can no longer be paid, so
    /// nothing reaches a contract anyone can sweep.
    function test_L1a_aListedRouterOrTokenIsNeverAPayee() public {
        SigilSelfWallet w = _fundedWallet();
        _configureLikeTheVault(w, 0, 0);

        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientNotAllowed.selector, attacker));
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.transfer.selector, attacker, 50e6));

        uint256 routerBefore = IERC20(usdg).balanceOf(router);
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientNotAllowed.selector, router));
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.transfer.selector, router, 50e6));
        // Nothing is left on the router for the attacker to sweep.
        uint256 before = IERC20(usdg).balanceOf(attacker);
        vm.prank(attacker);
        _sweep(usdg, attacker);
        assertEq(IERC20(usdg).balanceOf(attacker) - before, routerBefore);
        assertEq(IERC20(usdg).balanceOf(address(w)), 500e6);

        // A token address is not a recipient either: no USDG can be paid to the USDG contract.
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientNotAllowed.selector, usdg));
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.transfer.selector, usdg, 1e6));
        // Nor can the self key give a listed contract an allowance.
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientNotAllowed.selector, router));
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.approve.selector, router, 50e6));
        // A plain payment to the router is refused too.
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientNotAllowed.selector, router));
        w.execute(router, 0.01 ether, "");
    }

    /// Fixed: an address is a recipient or a contract, never both, whichever way the owner sets it.
    function test_L1_noAddressIsBothRecipientAndContract() public {
        SigilSelfWallet w = _fundedWallet();
        address[] memory both = new address[](1);
        both[0] = router;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientAndContract.selector, router));
        w.configure(0, 0, 0, both, both, new SigilSelfWallet.SelectorRule[](0), new SigilSelfWallet.TokenLimit[](0));
        _configureLikeTheVault(w, 0, 0);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientAndContract.selector, router));
        w.setRecipient(router, true);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientAndContract.selector, friend));
        w.setTarget(friend, true);
        vm.stopPrank();
    }

    /// By design and now told to the owner in the vault: a listed function's arguments are not
    /// read, so a router call can send value inside the native cap to any address. The cap holds.
    function test_L1b_aListedFunctionStaysWithinTheCap() public {
        SigilSelfWallet w = _fundedWallet();
        _configureLikeTheVault(w, 0.01 ether, 0.01 ether);

        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientNotAllowed.selector, attacker));
        w.execute(attacker, 0.01 ether, "");

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(attacker, uint256(0.02 ether));
        bytes memory over = abi.encodeWithSelector(IUniversalRouter.execute.selector, abi.encodePacked(CMD_WRAP_ETH), inputs, block.timestamp + 60);
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverTxCap.selector, 0.02 ether, 0.01 ether));
        w.execute(router, 0.02 ether, over);

        inputs[0] = abi.encode(attacker, uint256(0.01 ether));
        bytes memory within = abi.encodeWithSelector(IUniversalRouter.execute.selector, abi.encodePacked(CMD_WRAP_ETH), inputs, block.timestamp + 60);
        vm.prank(selfKey);
        w.execute(router, 0.01 ether, within);
        assertEq(IERC20(weth).balanceOf(attacker), 0.01 ether);
        assertEq(w.remainingToday(), 0);
    }

    // ------------------------------------------------------------------ L-2

    /// Fixed: a transfer only proposes. The named owner must accept with its own call; until it
    /// does nothing changes, and the old wallet entry is not inherited.
    function test_L2_theNewOwnerMustAccept() public {
        SigilSelfRegistry reg = new SigilSelfRegistry();
        address mallory = makeAddr("mallory");
        address victim = makeAddr("victim");
        uint256 deadline = block.timestamp + 1 hours;
        string memory uri = "https://example.invalid/api/identity/at/self";
        bytes32 digest = reg.registerDigest(mallory, selfKey, uri, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(selfPk, digest);
        vm.startPrank(mallory);
        reg.register(selfKey, uri, deadline, abi.encodePacked(r, s, v));
        reg.setWallet(selfKey, address(0xBEEF));
        reg.transferIdentity(selfKey, victim);
        vm.stopPrank();

        // Nothing moved: the victim is only proposed.
        assertEq(reg.identityOf(selfKey).owner, mallory);
        assertEq(reg.pendingOwner(selfKey), victim);
        assertEq(reg.registeredBy(victim), 0);
        // Nobody else can accept for the victim, mallory included.
        vm.prank(mallory);
        vm.expectRevert(SigilSelfRegistry.NotPendingOwner.selector);
        reg.acceptIdentity(selfKey);
        vm.prank(attacker);
        vm.expectRevert(SigilSelfRegistry.NotPendingOwner.selector);
        reg.acceptIdentity(selfKey);

        // When the new owner does accept, it owns the identity, and the old wallet claim is gone.
        vm.prank(victim);
        reg.acceptIdentity(selfKey);
        SigilSelfRegistry.Identity memory id = reg.identityOf(selfKey);
        assertEq(id.owner, victim);
        assertEq(id.wallet, address(0));
        assertEq(reg.registeredBy(victim), 1);
        assertEq(reg.pendingOwner(selfKey), address(0));
        // The old owner can do nothing any more.
        vm.prank(mallory);
        vm.expectRevert(SigilSelfRegistry.NotOwner.selector);
        reg.setWallet(selfKey, address(0xBEEF));
    }

    // ------------------------------------------------------------------ sound, still

    /// The day cap holds across direct calls, signed calls and a new rule set in one UTC day.
    function test_sound_dayCapAcrossPathsAndNewRules() public {
        SigilSelfWallet w = _fundedWallet();
        _configureLikeTheVault(w, 0, 0);
        vm.prank(selfKey);
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.transfer.selector, friend, 30e6));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory data = abi.encodeWithSelector(IERC20.transfer.selector, friend, 20e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(selfPk, w.executeDigest(usdg, 0, data, w.nonce(), deadline, 0));
        w.executeWithSig(usdg, 0, data, deadline, 0, abi.encodePacked(r, s, v));
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        w.executeWithSig(usdg, 0, data, deadline, 0, abi.encodePacked(r, s, v));
        _configureLikeTheVault(w, 0, 0);
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverDayCap.selector, 50e6 + 1, 50e6));
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.transfer.selector, friend, 1));
        vm.prank(owner);
        w.setSelector(usdg, bytes4(0x23b872dd), true);
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.TokenMoveRefused.selector, bytes4(0x23b872dd)));
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.transferFrom.selector, address(w), friend, 1));
    }

    // ------------------------------------------------------------------ I-1

    /// Fixed: freezing sets every allowance the self key gave back to zero; the spender can pull
    /// nothing after it.
    function test_info_freezeRevokesTheSelfsAllowances() public {
        SigilSelfWallet w = _fundedWallet();
        _configureLikeTheVault(w, 0, 0);
        vm.prank(selfKey);
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.approve.selector, friend, 50e6));
        assertEq(IERC20(usdg).allowance(address(w), friend), 50e6);
        assertEq(w.openApprovals().length, 1);
        vm.prank(owner);
        w.freeze();
        assertEq(IERC20(usdg).allowance(address(w), friend), 0);
        assertEq(w.openApprovals().length, 0);
        vm.prank(friend);
        vm.expectRevert();
        IERC20(usdg).transferFrom(address(w), friend, 50e6);
    }

    /// The self key freezing itself revokes too, and so does revokeApprovals without a freeze.
    function test_info_revokeApprovalsWithoutAFreeze() public {
        SigilSelfWallet w = _fundedWallet();
        _configureLikeTheVault(w, 0, 0);
        vm.startPrank(selfKey);
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.approve.selector, friend, 10e6));
        w.revokeApprovals();
        vm.stopPrank();
        assertEq(IERC20(usdg).allowance(address(w), friend), 0);
        assertFalse(w.frozen());
        vm.prank(attacker);
        vm.expectRevert(SigilSelfWallet.NotOwnerOrSelf.selector);
        w.revokeApprovals();
    }

    // ------------------------------------------------------------------ I-2

    /// Fixed: a call with no data goes only to a recipient, so no contract's fallback runs on an empty call.
    function test_info_anEmptyCallNeverReachesAContract() public {
        SigilSelfWallet w = _fundedWallet();
        EmptyCallForwarder fwd = new EmptyCallForwarder(attacker);
        address[] memory targets = new address[](1);
        targets[0] = address(fwd);
        vm.prank(owner);
        w.configure(1 ether, 1 ether, 0, new address[](0), targets, new SigilSelfWallet.SelectorRule[](0), new SigilSelfWallet.TokenLimit[](0));
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientNotAllowed.selector, address(fwd)));
        w.execute(address(fwd), 0, "");
        assertEq(fwd.runs(), 0);
    }

    // ------------------------------------------------------------------ I-4

    function _catcherWallet() internal returns (SigilSelfWallet w, Catcher c) {
        w = _fundedWallet();
        c = new Catcher();
        address[] memory targets = new address[](1);
        targets[0] = address(c);
        SigilSelfWallet.SelectorRule[] memory sels = new SigilSelfWallet.SelectorRule[](1);
        sels[0] = SigilSelfWallet.SelectorRule(address(c), Catcher.work.selector);
        vm.prank(owner);
        w.configure(0, 0, 0, new address[](0), targets, sels, new SigilSelfWallet.TokenLimit[](0));
    }

    function _signWork(SigilSelfWallet w, Catcher c, uint256 gas) internal view returns (bytes memory data, bytes memory sig, uint256 deadline) {
        data = abi.encodeCall(Catcher.work, ());
        deadline = block.timestamp + 1 hours;
        bytes32 digest = w.executeDigest(address(c), 0, data, w.nonce(), deadline, gas);
        sig = _sig(digest);
    }

    function _sig(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(selfPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Fixed: the self key signs the gas its call gets. A submitter who sends too little cannot
    /// make the call run short and "succeed"; the whole call reverts and the nonce is not spent.
    function test_info_aSubmitterCannotStarveASignedCall() public {
        (SigilSelfWallet w, Catcher c) = _catcherWallet();
        // Without a signed gas amount the degraded run is possible: the call returns false.
        (bytes memory data, bytes memory sig, uint256 deadline) = _signWork(w, c, 0);
        bytes memory ret = w.executeWithSig{gas: 400_000}(address(c), 0, data, deadline, 0, sig);
        assertFalse(abi.decode(ret, (bool)));
        // With 600,000 signed, the same short submission reverts.
        uint256 n = w.nonce();
        (data, sig, deadline) = _signWork(w, c, 600_000);
        vm.expectRevert(SigilSelfWallet.NotEnoughGas.selector);
        w.executeWithSig{gas: 400_000}(address(c), 0, data, deadline, 600_000, sig);
        assertEq(w.nonce(), n);
        // Given enough, the call runs in full.
        ret = w.executeWithSig{gas: 800_000}(address(c), 0, data, deadline, 600_000, sig);
        assertTrue(abi.decode(ret, (bool)));
        // And the signed gas cannot be swapped for another amount.
        (data, sig, deadline) = _signWork(w, c, 600_000);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        w.executeWithSig(address(c), 0, data, deadline, 0, sig);
    }

    // ------------------------------------------------------------------ the fixes, further

    /// The list of the self's allowances: an approve of zero takes a pair off, and it never grows
    /// past MAX_OPEN_APPROVALS.
    function test_openApprovalsAreKeptAndBounded() public {
        SigilSelfWallet w = _fundedWallet();
        uint256 max = w.MAX_OPEN_APPROVALS();
        address[] memory recipients = new address[](max + 1);
        for (uint256 i = 0; i <= max; i++) recipients[i] = address(uint160(0x1000 + i));
        address[] memory targets = new address[](1);
        targets[0] = usdg;
        SigilSelfWallet.SelectorRule[] memory sels = new SigilSelfWallet.SelectorRule[](1);
        sels[0] = SigilSelfWallet.SelectorRule(usdg, bytes4(0x095ea7b3));
        SigilSelfWallet.TokenLimit[] memory toks = new SigilSelfWallet.TokenLimit[](1);
        toks[0] = SigilSelfWallet.TokenLimit(usdg, 1e6, 100e6);
        vm.prank(owner);
        w.configure(0, 0, 0, recipients, targets, sels, toks);
        vm.startPrank(selfKey);
        for (uint256 i = 0; i < max; i++) w.execute(usdg, 0, abi.encodeWithSelector(IERC20.approve.selector, recipients[i], 1));
        assertEq(w.openApprovals().length, max);
        // The same pair again is not listed twice.
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.approve.selector, recipients[0], 2));
        assertEq(w.openApprovals().length, max);
        vm.expectRevert(SigilSelfWallet.TooManyOpenApprovals.selector);
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.approve.selector, recipients[max], 1));
        // Approving zero takes the pair off the list, and makes room.
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.approve.selector, recipients[3], 0));
        assertEq(w.openApprovals().length, max - 1);
        w.execute(usdg, 0, abi.encodeWithSelector(IERC20.approve.selector, recipients[max], 1));
        vm.stopPrank();
        // A freeze with every slot full still goes through, and clears them all.
        vm.prank(owner);
        w.freeze();
        assertEq(w.openApprovals().length, 0);
        for (uint256 i = 0; i <= max; i++) assertEq(IERC20(usdg).allowance(address(w), recipients[i]), 0);
    }

    /// No token can stop a freeze: one that reverts, one that burns all the gas it gets, and one
    /// that returns a huge answer. The wallet is frozen, the good allowance is cleared, and the
    /// refused ones stay listed for the owner to see.
    function test_aBadTokenNeverStopsAFreeze() public {
        if (forked) return;
        SigilSelfWallet w = _fundedWallet();
        RevertingToken rev = new RevertingToken();
        GasBurningToken burn = new GasBurningToken();
        ReturnBombToken bomb = new ReturnBombToken();
        address[] memory recipients = new address[](1);
        recipients[0] = friend;
        address[] memory targets = new address[](4);
        targets[0] = address(rev);
        targets[1] = address(burn);
        targets[2] = address(bomb);
        targets[3] = usdg;
        SigilSelfWallet.SelectorRule[] memory sels = new SigilSelfWallet.SelectorRule[](4);
        SigilSelfWallet.TokenLimit[] memory toks = new SigilSelfWallet.TokenLimit[](4);
        for (uint256 i = 0; i < 4; i++) {
            sels[i] = SigilSelfWallet.SelectorRule(targets[i], bytes4(0x095ea7b3));
            toks[i] = SigilSelfWallet.TokenLimit(targets[i], 10, 10);
        }
        vm.prank(owner);
        w.configure(0, 0, 0, recipients, targets, sels, toks);
        vm.startPrank(selfKey);
        for (uint256 i = 0; i < 4; i++) w.execute(targets[i], 0, abi.encodeWithSelector(IERC20.approve.selector, friend, 5));
        vm.stopPrank();
        rev.setStuck(true);
        burn.setBurn(true);
        bomb.setBomb(true);
        vm.prank(selfKey);
        w.freeze{gas: 2_000_000}();
        assertTrue(w.frozen());
        assertEq(IERC20(usdg).allowance(address(w), friend), 0);
        assertEq(bomb.allowance(address(w), friend), 0);
        SigilSelfWallet.Approval[] memory left = w.openApprovals();
        assertEq(left.length, 2);
        assertEq(rev.allowance(address(w), friend), 5);
        // The owner can still clear them with ownerExecute once the token allows it.
        rev.setStuck(false);
        vm.prank(owner);
        w.revokeApprovals();
        assertEq(rev.allowance(address(w), friend), 0);
        assertEq(w.openApprovals().length, 1);
    }

    /// Whatever recipient and amount the self key names, no token ever reaches an address that
    /// is not a recipient.
    function testFuzz_tokensOnlyEverReachRecipients(address to, uint64 amount, bool approve_) public {
        vm.assume(to != friend);
        SigilSelfWallet w = _fundedWallet();
        _configureLikeTheVault(w, 0, 0);
        bytes4 sel = approve_ ? IERC20.approve.selector : IERC20.transfer.selector;
        vm.prank(selfKey);
        vm.expectRevert();
        w.execute(usdg, 0, abi.encodeWithSelector(sel, to, uint256(amount) % 50e6));
        assertEq(IERC20(usdg).balanceOf(address(w)), 500e6);
    }
}
