// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Regression tests for the Oak Agent Kit Sapling Review (Acorn Audits) of commit f106012:
// one test per finding, each the reviewer's own scenario, now showing the fix holds.

import {Test} from "forge-std/Test.sol";
import {SigilSelfWallet} from "../src/SigilSelfWallet.sol";
import {SigilSelfRegistry} from "../src/SigilSelfRegistry.sol";

contract OakToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }

    function transferAndCall(address to, uint256 a, bytes calldata) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// Reverts on approve(x, 0), like some older tokens.
contract OakNoZeroApproveToken {
    mapping(address => mapping(address => uint256)) public allowance;

    function approve(address s, uint256 a) external returns (bool) {
        require(a != 0, "zero approval refused");
        allowance[msg.sender][s] = a;
        return true;
    }
}

/// On approve(x, 0) while armed, sends one call the self key signed back into the wallet.
contract OakCallbackToken {
    mapping(address => mapping(address => uint256)) public allowance;
    SigilSelfWallet public w;
    address public target;
    bytes public data;
    uint256 public dl;
    bytes public sig;
    bool public armed;
    bool public reentered;

    function arm(SigilSelfWallet w_, address target_, bytes calldata data_, uint256 dl_, bytes calldata sig_) external {
        (w, target, data, dl, sig, armed) = (w_, target_, data_, dl_, sig_, true);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        if (amount == 0 && armed) {
            armed = false;
            try w.executeWithSig(target, 0, data, dl, 0, sig) {
                reentered = true;
            } catch {}
        }
        return true;
    }
}

contract OakSaplingTest is Test {
    bytes4 internal constant TRANSFER = 0xa9059cbb;
    bytes4 internal constant APPROVE = 0x095ea7b3;
    bytes4 internal constant TRANSFER_AND_CALL = 0x4000aea0;

    address internal owner = makeAddr("owner");
    uint256 internal selfPk = 0x5E1F;
    address internal selfKey = vm.addr(selfPk);
    address internal friend = makeAddr("friend");
    address internal friend2 = makeAddr("friend2");
    address internal attacker = makeAddr("attacker");
    SigilSelfWallet internal wallet;

    function setUp() public {
        vm.warp(1_800_000_000);
        wallet = new SigilSelfWallet(owner, selfKey);
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _sels(address token, bytes4[] memory sels) internal pure returns (SigilSelfWallet.SelectorRule[] memory s) {
        s = new SigilSelfWallet.SelectorRule[](sels.length);
        for (uint256 i = 0; i < sels.length; i++) s[i] = SigilSelfWallet.SelectorRule(token, sels[i]);
    }

    function _limit(address token, uint128 perTx, uint128 perDay) internal pure returns (SigilSelfWallet.TokenLimit[] memory l) {
        l = new SigilSelfWallet.TokenLimit[](1);
        l[0] = SigilSelfWallet.TokenLimit(token, perTx, perDay);
    }

    function _cfg(address token, bytes4[] memory sels, uint128 perTx, uint128 perDay, address[] memory recs) internal {
        vm.prank(owner);
        wallet.configure(0, 0, 0, recs, _one(token), _sels(token, sels), _limit(token, perTx, perDay));
    }

    function _self(address target, bytes memory data) internal {
        vm.prank(selfKey);
        wallet.execute(target, 0, data);
    }

    function _sig(address target, bytes memory data, uint256 n, uint256 dl) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(selfPk, wallet.executeDigest(target, 0, data, n, dl, 0));
        return abi.encodePacked(r, s, v);
    }

    /// M1: new rules that leave a once-capped token's limit out keep its other functions refused.
    function test_M1_newRulesWithoutTheLimitKeepTheGuard() public {
        OakToken token = new OakToken();
        token.mint(address(wallet), 1_000e18);
        bytes4[] memory sels = new bytes4[](2);
        sels[0] = TRANSFER;
        sels[1] = TRANSFER_AND_CALL;
        _cfg(address(token), sels, 100e18, 250e18, _one(friend));
        vm.prank(owner);
        wallet.configure(0, 0, 0, _one(friend), _one(address(token)), _sels(address(token), sels), new SigilSelfWallet.TokenLimit[](0));
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.TokenMoveRefused.selector, TRANSFER_AND_CALL));
        wallet.execute(address(token), 0, abi.encodeWithSelector(TRANSFER_AND_CALL, attacker, uint256(1_000e18), bytes("")));
        assertEq(token.balanceOf(attacker), 0);
    }

    /// L1: a recipient removed by new rules, or by setRecipient, loses the allowance the self key gave it.
    function test_L1_removingARecipientRevokesItsAllowance() public {
        for (uint256 viaConfigure = 0; viaConfigure < 2; viaConfigure++) {
            setUp();
            OakToken token = new OakToken();
            token.mint(address(wallet), 1_000e18);
            bytes4[] memory sels = new bytes4[](2);
            sels[0] = TRANSFER;
            sels[1] = APPROVE;
            address[] memory both = new address[](2);
            (both[0], both[1]) = (friend, friend2);
            _cfg(address(token), sels, 250e18, 250e18, both);
            _self(address(token), abi.encodeWithSelector(APPROVE, friend, uint256(200e18)));
            if (viaConfigure == 1) {
                _cfg(address(token), sels, 250e18, 250e18, _one(friend2));
            } else {
                vm.prank(owner);
                wallet.setRecipient(friend, false);
            }
            assertEq(token.allowance(address(wallet), friend), 0, "allowance revoked");
            assertEq(wallet.openApprovals().length, 0);
            vm.prank(friend);
            vm.expectRevert();
            token.transferFrom(address(wallet), friend, 1);
        }
    }

    /// L1: the self key can always set an allowance it gave back to zero, even once the address is off the list.
    function test_L1_theSelfKeyCanTakeBackAnAllowanceFromAnUnlistedAddress() public {
        OakToken token = new OakToken();
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = APPROVE;
        _cfg(address(token), sels, 250e18, 250e18, _one(friend));
        _self(address(token), abi.encodeWithSelector(APPROVE, friend, uint256(100e18)));
        // The token refuses the automatic reset once, so the allowance stays listed.
        vm.mockCallRevert(address(token), abi.encodeWithSelector(APPROVE, friend, uint256(0)), "busy");
        vm.prank(owner);
        wallet.setRecipient(friend, false);
        assertEq(wallet.openApprovals().length, 1, "still listed while the token refused");
        vm.clearMockedCalls();
        _self(address(token), abi.encodeWithSelector(APPROVE, friend, uint256(0)));
        assertEq(token.allowance(address(wallet), friend), 0);
        assertEq(wallet.openApprovals().length, 0);
    }

    /// L2: an accept fails if the metadata changed after the offer the new owner saw.
    function test_L2_acceptBindsTheMetadataOnOffer() public {
        SigilSelfRegistry reg = new SigilSelfRegistry();
        address seller = makeAddr("seller");
        address buyer = makeAddr("buyer");
        address key = vm.addr(0xC0DE);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xC0DE, reg.registerDigest(seller, key, "https://good.example/self", dl));
        vm.startPrank(seller);
        reg.register(key, "https://good.example/self", dl, abi.encodePacked(r, s, v));
        reg.transferIdentity(key, buyer);
        reg.cancelTransfer(key);
        reg.setMetadata(key, "https://other.example/self");
        reg.transferIdentity(key, buyer);
        vm.stopPrank();
        vm.prank(buyer);
        vm.expectRevert(SigilSelfRegistry.MetadataNotAsOffered.selector);
        reg.acceptIdentity(key, keccak256(bytes("https://good.example/self")));
        vm.prank(buyer);
        reg.acceptIdentity(key, keccak256(bytes("https://other.example/self")));
        assertEq(reg.identityOf(key).owner, buyer);
    }

    /// N19: nothing to accept when nothing is pending.
    function test_N19_noAcceptWithNothingPending() public {
        SigilSelfRegistry reg = new SigilSelfRegistry();
        address seller = makeAddr("seller");
        address key = vm.addr(0xC0DE);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xC0DE, reg.registerDigest(seller, key, "u", dl));
        vm.prank(seller);
        reg.register(key, "u", dl, abi.encodePacked(r, s, v));
        vm.prank(address(0));
        vm.expectRevert(SigilSelfRegistry.NotPendingOwner.selector);
        reg.acceptIdentity(key, keccak256(bytes("u")));
    }

    /// L3: a token cannot call back into the wallet while revokeApprovals runs, so nothing survives the freeze.
    function test_L3_noReentryDuringRevoke() public {
        OakCallbackToken token = new OakCallbackToken();
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = APPROVE;
        _cfg(address(token), sels, 50e6, 100e6, _one(friend));
        _self(address(token), abi.encodeWithSelector(APPROVE, friend, uint256(50e6)));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory d = abi.encodeWithSelector(APPROVE, friend, uint256(40e6));
        token.arm(wallet, address(token), d, dl, _sig(address(token), d, wallet.nonce(), dl));
        vm.startPrank(owner);
        wallet.revokeApprovals();
        wallet.freeze();
        vm.stopPrank();
        assertFalse(token.reentered(), "the call back was refused");
        assertEq(token.allowance(address(wallet), friend), 0);
        assertEq(wallet.openApprovals().length, 0);
    }

    /// L4: the owner can drop an entry a token refuses to reset, so the list never fills for good.
    function test_L4_theOwnerCanForgetAStuckAllowance() public {
        OakNoZeroApproveToken poison = new OakNoZeroApproveToken();
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = APPROVE;
        _cfg(address(poison), sels, 1_000, 1_000_000, _one(friend));
        _self(address(poison), abi.encodeWithSelector(APPROVE, friend, uint256(1)));
        vm.prank(owner);
        wallet.freeze();
        assertEq(wallet.openApprovals().length, 1, "the token refused the reset");
        vm.prank(selfKey);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.forgetApproval(address(poison), friend);
        vm.prank(owner);
        wallet.forgetApproval(address(poison), friend);
        assertEq(wallet.openApprovals().length, 0);
    }
}
