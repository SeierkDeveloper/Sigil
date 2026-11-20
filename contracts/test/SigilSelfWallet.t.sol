// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SigilSelfWallet} from "../src/SigilSelfWallet.sol";

/// A plain ERC-20 for the token rules.
contract TestToken {
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

/// A contract the self may call.
contract Shop {
    uint256 public orders;
    uint256 public paid;

    function order(uint256 n) external payable returns (uint256) {
        orders += n;
        paid += msg.value;
        return orders;
    }

    function cancel() external pure {
        revert("closed");
    }
}

contract SigilSelfWalletTest is Test {
    SigilSelfWallet internal wallet;
    TestToken internal token;
    Shop internal shop;

    address internal owner = makeAddr("owner");
    uint256 internal selfPk = 0xA11CE;
    address internal selfKey;
    address internal friend = makeAddr("friend");
    address internal stranger = makeAddr("stranger");
    address internal relayer = makeAddr("relayer");

    bytes4 internal constant ORDER = Shop.order.selector;

    function setUp() public {
        vm.warp(1_800_000_000);
        selfKey = vm.addr(selfPk);
        wallet = new SigilSelfWallet(owner, selfKey);
        token = new TestToken();
        shop = new Shop();
        vm.deal(address(wallet), 100 ether);
        token.mint(address(wallet), 1_000_000e18);
        _configure(1 ether, 3 ether, 0);
    }

    // ---------------------------------------------------------------- helpers

    function _configure(uint256 perTx, uint256 perDay, uint64 expiry) internal {
        address[] memory targets = new address[](3);
        targets[0] = friend;
        targets[1] = address(shop);
        targets[2] = address(token);
        SigilSelfWallet.SelectorRule[] memory sels = new SigilSelfWallet.SelectorRule[](3);
        sels[0] = SigilSelfWallet.SelectorRule(address(shop), ORDER);
        sels[1] = SigilSelfWallet.SelectorRule(address(token), TestToken.transfer.selector);
        sels[2] = SigilSelfWallet.SelectorRule(address(token), TestToken.approve.selector);
        SigilSelfWallet.TokenLimit[] memory limits = new SigilSelfWallet.TokenLimit[](1);
        limits[0] = SigilSelfWallet.TokenLimit(address(token), 100e18, 250e18);
        vm.prank(owner);
        wallet.configure(perTx, perDay, expiry, targets, sels, limits);
    }

    function _pay(address to, uint256 value) internal {
        vm.prank(selfKey);
        wallet.execute(to, value, "");
    }

    function _sign(uint256 pk, address target, uint256 value, bytes memory data, uint256 n, uint256 deadline) internal view returns (bytes memory) {
        bytes32 digest = wallet.executeDigest(target, value, data, n, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------- spending within the rules

    function testSelfPaysAnAllowedRecipient() public {
        _pay(friend, 0.5 ether);
        assertEq(friend.balance, 0.5 ether);
        assertEq(wallet.nonce(), 1);
        assertEq(wallet.remainingToday(), 2.5 ether);
    }

    function testSelfCallsAnAllowedFunction() public {
        vm.prank(selfKey);
        bytes memory ret = wallet.execute(address(shop), 0.2 ether, abi.encodeCall(Shop.order, (3)));
        assertEq(abi.decode(ret, (uint256)), 3);
        assertEq(shop.orders(), 3);
        assertEq(shop.paid(), 0.2 ether);
    }

    function testExecutedEventNamesTheCall() public {
        vm.expectEmit(true, true, false, true);
        emit SigilSelfWallet.Executed(0, address(shop), 0, ORDER, address(0), 0);
        vm.prank(selfKey);
        wallet.execute(address(shop), 0, abi.encodeCall(Shop.order, (1)));
    }

    function testOnlyTheSelfKeyExecutes() public {
        vm.prank(stranger);
        vm.expectRevert(SigilSelfWallet.NotSelf.selector);
        wallet.execute(friend, 1, "");
        vm.prank(owner);
        vm.expectRevert(SigilSelfWallet.NotSelf.selector);
        wallet.execute(friend, 1, "");
    }

    function testTargetMustBeAllowed() public {
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.TargetNotAllowed.selector, stranger));
        wallet.execute(stranger, 1, "");
    }

    function testTheWalletItselfIsNeverATarget() public {
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.TargetNotAllowed.selector, address(wallet)));
        wallet.execute(address(wallet), 0, abi.encodeCall(SigilSelfWallet.unfreeze, ()));
    }

    function testSelectorMustBeAllowed() public {
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.SelectorNotAllowed.selector, address(shop), Shop.cancel.selector));
        wallet.execute(address(shop), 0, abi.encodeCall(Shop.cancel, ()));
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.SelectorNotAllowed.selector, address(shop), bytes4(0)));
        wallet.execute(address(shop), 0, hex"0102");
    }

    function testAFailedCallRevertsAndSpendsNothing() public {
        vm.prank(owner);
        wallet.setSelector(address(shop), Shop.cancel.selector, true);
        vm.prank(selfKey);
        vm.expectRevert();
        wallet.execute(address(shop), 0.5 ether, abi.encodeCall(Shop.cancel, ()));
        assertEq(wallet.remainingToday(), 3 ether);
        assertEq(wallet.nonce(), 0);
    }

    // ---------------------------------------------------------------- caps

    function testPerTransactionCap() public {
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverTxCap.selector, 1 ether + 1, 1 ether));
        wallet.execute(friend, 1 ether + 1, "");
    }

    function testPerDayCapAndTheNextDay() public {
        _pay(friend, 1 ether);
        _pay(friend, 1 ether);
        _pay(friend, 1 ether);
        assertEq(wallet.remainingToday(), 0);
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverDayCap.selector, 3 ether + 1, 3 ether));
        wallet.execute(friend, 1, "");
        vm.warp(block.timestamp + 1 days);
        assertEq(wallet.remainingToday(), 3 ether);
        _pay(friend, 1 ether);
        assertEq(friend.balance, 4 ether);
    }

    function testZeroCapsAllowOnlyCallsWithoutValue() public {
        _configure(0, 0, 0);
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverTxCap.selector, 1, 0));
        wallet.execute(friend, 1, "");
        vm.prank(selfKey);
        wallet.execute(address(shop), 0, abi.encodeCall(Shop.order, (1)));
        assertEq(shop.orders(), 1);
    }

    function testNewRulesDoNotResetTodaysSpending() public {
        _pay(friend, 1 ether);
        _pay(friend, 1 ether);
        _configure(1 ether, 2 ether, 0);
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverDayCap.selector, 2 ether + 1, 2 ether));
        wallet.execute(friend, 1, "");
    }

    // ---------------------------------------------------------------- tokens

    function testTokenTransferWithinItsCaps() public {
        vm.prank(selfKey);
        wallet.execute(address(token), 0, abi.encodeCall(TestToken.transfer, (friend, 100e18)));
        assertEq(token.balanceOf(friend), 100e18);
        assertEq(wallet.tokenRemainingToday(address(token)), 150e18);
    }

    function testTokenRecipientMustBeAllowed() public {
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientNotAllowed.selector, stranger));
        wallet.execute(address(token), 0, abi.encodeCall(TestToken.transfer, (stranger, 1)));
    }

    function testTokenCaps() public {
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverTxCap.selector, 100e18 + 1, 100e18));
        wallet.execute(address(token), 0, abi.encodeCall(TestToken.transfer, (friend, 100e18 + 1)));
        vm.startPrank(selfKey);
        wallet.execute(address(token), 0, abi.encodeCall(TestToken.transfer, (friend, 100e18)));
        wallet.execute(address(token), 0, abi.encodeCall(TestToken.approve, (address(shop), 100e18)));
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverDayCap.selector, 250e18 + 1, 250e18));
        wallet.execute(address(token), 0, abi.encodeCall(TestToken.transfer, (friend, 50e18 + 1)));
        vm.stopPrank();
    }

    function testATokenWithoutLimitsCannotBeMoved() public {
        TestToken other = new TestToken();
        other.mint(address(wallet), 10);
        vm.startPrank(owner);
        wallet.setTarget(address(other), true);
        wallet.setSelector(address(other), TestToken.transfer.selector, true);
        vm.stopPrank();
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.TokenNotAllowed.selector, address(other)));
        wallet.execute(address(other), 0, abi.encodeCall(TestToken.transfer, (friend, 1)));
    }

    function testTransferFromIsRefusedEvenWhenAllowed() public {
        vm.prank(owner);
        wallet.setSelector(address(token), TestToken.transferFrom.selector, true);
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.TokenMoveRefused.selector, TestToken.transferFrom.selector));
        wallet.execute(address(token), 0, abi.encodeCall(TestToken.transferFrom, (address(wallet), friend, 1)));
    }

    // ---------------------------------------------------------------- freeze, expiry, new rules

    function testOwnerFreezesAndUnfreezes() public {
        vm.prank(owner);
        wallet.freeze();
        assertTrue(wallet.frozen());
        vm.prank(selfKey);
        vm.expectRevert(SigilSelfWallet.IsFrozen.selector);
        wallet.execute(friend, 1, "");
        vm.prank(owner);
        wallet.unfreeze();
        _pay(friend, 1);
        assertEq(friend.balance, 1);
    }

    function testTheSelfCanFreezeButNotUnfreeze() public {
        vm.prank(selfKey);
        wallet.freeze();
        vm.prank(selfKey);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.unfreeze();
        vm.prank(stranger);
        vm.expectRevert(SigilSelfWallet.NotOwnerOrSelf.selector);
        wallet.freeze();
    }

    function testRulesExpire() public {
        _configure(1 ether, 3 ether, uint64(block.timestamp + 1 hours));
        _pay(friend, 1);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(selfKey);
        vm.expectRevert(SigilSelfWallet.RulesExpired.selector);
        wallet.execute(friend, 1, "");
    }

    function testConfigureReplacesTheOldRules() public {
        address[] memory targets = new address[](1);
        targets[0] = makeAddr("new friend");
        vm.prank(owner);
        wallet.configure(1 ether, 1 ether, 0, targets, new SigilSelfWallet.SelectorRule[](0), new SigilSelfWallet.TokenLimit[](0));
        assertEq(wallet.rulesVersion(), 3);
        assertFalse(wallet.isTargetAllowed(friend));
        assertFalse(wallet.isSelectorAllowed(address(shop), ORDER));
        (uint128 perTx,) = wallet.tokenLimit(address(token));
        assertEq(perTx, 0);
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.TargetNotAllowed.selector, friend));
        wallet.execute(friend, 1, "");
        _pay(targets[0], 1);
    }

    function testSingleRuleChanges() public {
        vm.startPrank(owner);
        wallet.setTarget(friend, false);
        wallet.setSelector(address(shop), ORDER, false);
        wallet.setTokenLimit(address(token), 1, 1);
        wallet.setLimits(2 ether, 2 ether, 0);
        vm.stopPrank();
        assertFalse(wallet.isTargetAllowed(friend));
        assertFalse(wallet.isSelectorAllowed(address(shop), ORDER));
        assertEq(wallet.perTxCap(), 2 ether);
        (uint128 perTx, uint128 perDay) = wallet.tokenLimit(address(token));
        assertEq(perTx, 1);
        assertEq(perDay, 1);
    }

    function testRotatingTheSelfKey() public {
        address next = vm.addr(0xB0B);
        vm.prank(owner);
        wallet.setSelfKey(next);
        vm.prank(selfKey);
        vm.expectRevert(SigilSelfWallet.NotSelf.selector);
        wallet.execute(friend, 1, "");
        vm.prank(next);
        wallet.execute(friend, 1, "");
        vm.prank(owner);
        wallet.setSelfKey(address(0));
        vm.prank(address(0));
        vm.expectRevert(SigilSelfWallet.NotSelf.selector);
        wallet.execute(friend, 1, "");
    }

    // ---------------------------------------------------------------- signed calls

    function testARelayerSubmitsASignedCall() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _sign(selfPk, friend, 0.25 ether, "", 0, deadline);
        vm.prank(relayer);
        wallet.executeWithSig(friend, 0.25 ether, "", deadline, sig);
        assertEq(friend.balance, 0.25 ether);
        // The same signature cannot be used twice: the nonce moved on.
        vm.prank(relayer);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 0.25 ether, "", deadline, sig);
    }

    function testSignedCallsFollowTheRulesToo() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _sign(selfPk, friend, 2 ether, "", 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverTxCap.selector, 2 ether, 1 ether));
        wallet.executeWithSig(friend, 2 ether, "", deadline, sig);
    }

    function testSignedCallsFromAnotherKeyOrTooLateFail() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory wrong = _sign(0xBAD, friend, 1, "", 0, deadline);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 1, "", deadline, wrong);
        bytes memory late = _sign(selfPk, friend, 1, "", 0, block.timestamp - 1);
        vm.expectRevert(SigilSelfWallet.Expired.selector);
        wallet.executeWithSig(friend, 1, "", block.timestamp - 1, late);
        // A signature over other data does not fit this call.
        bytes memory other = _sign(selfPk, friend, 2, "", 0, deadline);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 1, "", deadline, other);
    }

    function testHighSSignaturesAreRefused() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = wallet.executeDigest(friend, 1, "", 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(selfPk, digest);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 1, "", deadline, flipped);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 1, "", deadline, hex"1234");
    }

    // ---------------------------------------------------------------- the owner

    function testOwnerWithdrawsAtAnyTimeEvenFrozen() public {
        vm.startPrank(owner);
        wallet.freeze();
        wallet.withdraw(payable(owner), 40 ether);
        wallet.withdrawToken(address(token), owner, 5e18);
        vm.stopPrank();
        assertEq(owner.balance, 40 ether);
        assertEq(token.balanceOf(owner), 5e18);
    }

    function testOwnerCallsAnythingWithoutRules() public {
        vm.startPrank(owner);
        wallet.freeze();
        wallet.ownerExecute(stranger, 50 ether, "");
        vm.stopPrank();
        assertEq(stranger.balance, 50 ether);
    }

    function testOnlyTheOwnerAdministers() public {
        vm.startPrank(stranger);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.unfreeze();
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.setLimits(1, 1, 0);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.setTarget(stranger, true);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.setSelector(stranger, ORDER, true);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.setTokenLimit(address(token), 1, 1);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.setSelfKey(stranger);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.transferOwnership(stranger);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.withdraw(payable(stranger), 1);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.withdrawToken(address(token), stranger, 1);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.ownerExecute(stranger, 1, "");
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.configure(1, 1, 0, new address[](0), new SigilSelfWallet.SelectorRule[](0), new SigilSelfWallet.TokenLimit[](0));
        vm.stopPrank();
        // The self key is no owner either.
        vm.prank(selfKey);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.withdraw(payable(selfKey), 1);
    }

    function testTransferOwnership() public {
        vm.prank(owner);
        wallet.transferOwnership(stranger);
        assertEq(wallet.owner(), stranger);
        vm.prank(owner);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.unfreeze();
        vm.prank(stranger);
        vm.expectRevert(SigilSelfWallet.ZeroAddress.selector);
        wallet.transferOwnership(address(0));
    }

    function testReceivesValue() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(wallet).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(wallet).balance, 101 ether);
    }

    // ---------------------------------------------------------------- fuzzing

    /// Whatever the self key tries, no single call passes the cap per transaction and no day passes the cap per day.
    function testFuzzCapsHold(uint96 perTxSeed, uint96 perDaySeed, uint64[12] calldata amounts, uint8[12] calldata waits) public {
        // Twelve calls at five ether at most stay within the hundred the wallet holds.
        uint256 perTx = bound(perTxSeed, 0, 5 ether);
        uint256 perDay = bound(perDaySeed, 0, 12 ether);
        _configure(perTx, perDay, 0);
        uint256 day = block.timestamp / 1 days;
        uint256 spentToday;
        for (uint256 i = 0; i < amounts.length; i++) {
            if (waits[i] % 4 == 0) vm.warp(block.timestamp + uint256(waits[i]) * 1 hours);
            if (block.timestamp / 1 days != day) {
                day = block.timestamp / 1 days;
                spentToday = 0;
            }
            uint256 amount = uint256(amounts[i]) % (perTx * 2 + 2);
            bool fits = amount <= perTx && spentToday + amount <= perDay;
            uint256 before = friend.balance;
            vm.prank(selfKey);
            if (fits) {
                wallet.execute(friend, amount, "");
                spentToday += amount;
                assertEq(friend.balance, before + amount);
            } else {
                vm.expectRevert();
                wallet.execute(friend, amount, "");
                assertEq(friend.balance, before);
            }
            assertLe(spentToday, perDay);
            assertEq(wallet.remainingToday(), perDay - spentToday);
        }
    }

    /// The same for one token.
    function testFuzzTokenCapsHold(uint64 perTx, uint64 perDay, uint64[8] calldata amounts) public {
        vm.prank(owner);
        wallet.setTokenLimit(address(token), perTx, perDay);
        uint256 spent;
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 amount = uint256(amounts[i]) % (uint256(perTx) * 2 + 2);
            bool fits = perTx > 0 && amount <= perTx && spent + amount <= perDay;
            vm.prank(selfKey);
            if (fits) {
                wallet.execute(address(token), 0, abi.encodeCall(TestToken.transfer, (friend, amount)));
                spent += amount;
            } else {
                vm.expectRevert();
                wallet.execute(address(token), 0, abi.encodeCall(TestToken.transfer, (friend, amount)));
            }
            assertEq(token.balanceOf(friend), spent);
        }
    }

    /// Frozen, the self key can do nothing at all, signed or not; the owner still can.
    function testFuzzFrozenStopsTheSelf(uint256 value, bytes calldata data, bool byOwner) public {
        vm.prank(byOwner ? owner : selfKey);
        wallet.freeze();
        address[3] memory targets = [friend, address(shop), address(token)];
        for (uint256 i = 0; i < targets.length; i++) {
            vm.prank(selfKey);
            vm.expectRevert(SigilSelfWallet.IsFrozen.selector);
            wallet.execute(targets[i], value, data);
        }
        uint256 deadline = block.timestamp + 1;
        bytes memory sig = _sign(selfPk, friend, value, data, 0, deadline);
        vm.expectRevert(SigilSelfWallet.IsFrozen.selector);
        wallet.executeWithSig(friend, value, data, deadline, sig);
        assertEq(wallet.nonce(), 0);
        vm.prank(owner);
        wallet.withdraw(payable(owner), 1 ether);
        assertEq(owner.balance, 1 ether);
    }

    /// Any target that is not on the list is refused, whatever the call.
    function testFuzzUnlistedTargetsAreRefused(address target, uint64 value, bytes calldata data) public {
        vm.assume(target != friend && target != address(shop) && target != address(token));
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.TargetNotAllowed.selector, target));
        wallet.execute(target, value, data);
    }

    /// Past the expiry nothing passes, at any later time.
    function testFuzzExpiryHolds(uint32 after_) public {
        _configure(1 ether, 3 ether, uint64(block.timestamp + 1));
        vm.warp(block.timestamp + 1 + after_);
        vm.prank(selfKey);
        vm.expectRevert(SigilSelfWallet.RulesExpired.selector);
        wallet.execute(friend, 1, "");
    }
}
