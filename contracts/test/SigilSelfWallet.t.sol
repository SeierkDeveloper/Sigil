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

    /// A token function that moves value without being transfer or approve (as in ERC-1363).
    function transferAndCall(address to, uint256 amount, bytes calldata) external returns (bool) {
        balanceOf[msg.sender] -= amount;
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
        address[] memory recipients = new address[](1);
        recipients[0] = friend;
        address[] memory targets = new address[](2);
        targets[0] = address(shop);
        targets[1] = address(token);
        SigilSelfWallet.SelectorRule[] memory sels = new SigilSelfWallet.SelectorRule[](3);
        sels[0] = SigilSelfWallet.SelectorRule(address(shop), ORDER);
        sels[1] = SigilSelfWallet.SelectorRule(address(token), TestToken.transfer.selector);
        sels[2] = SigilSelfWallet.SelectorRule(address(token), TestToken.approve.selector);
        SigilSelfWallet.TokenLimit[] memory limits = new SigilSelfWallet.TokenLimit[](1);
        limits[0] = SigilSelfWallet.TokenLimit(address(token), 100e18, 250e18);
        vm.prank(owner);
        wallet.configure(perTx, perDay, expiry, recipients, targets, sels, limits);
    }

    function _pay(address to, uint256 value) internal {
        vm.prank(selfKey);
        wallet.execute(to, value, "");
    }

    function _sign(uint256 pk, address target, uint256 value, bytes memory data, uint256 n, uint256 deadline) internal view returns (bytes memory) {
        bytes32 digest = wallet.executeDigest(target, value, data, n, deadline, 0);
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
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientNotAllowed.selector, stranger));
        wallet.execute(stranger, 1, "");
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.TargetNotAllowed.selector, stranger));
        wallet.execute(stranger, 0, abi.encodeCall(Shop.order, (1)));
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
        wallet.execute(address(token), 0, abi.encodeCall(TestToken.approve, (friend, 100e18)));
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
        wallet.configure(1 ether, 1 ether, 0, targets, new address[](0), new SigilSelfWallet.SelectorRule[](0), new SigilSelfWallet.TokenLimit[](0));
        assertEq(wallet.rulesVersion(), 3);
        assertFalse(wallet.isRecipient(friend));
        assertFalse(wallet.isTargetAllowed(address(shop)));
        assertFalse(wallet.isSelectorAllowed(address(shop), ORDER));
        (uint128 perTx,) = wallet.tokenLimit(address(token));
        assertEq(perTx, 0);
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientNotAllowed.selector, friend));
        wallet.execute(friend, 1, "");
        _pay(targets[0], 1);
    }

    function testSingleRuleChanges() public {
        vm.startPrank(owner);
        wallet.setRecipient(friend, false);
        wallet.setTarget(address(shop), false);
        wallet.setSelector(address(shop), ORDER, false);
        wallet.setTokenLimit(address(token), 1, 1);
        wallet.setLimits(2 ether, 2 ether, 0);
        vm.stopPrank();
        assertFalse(wallet.isRecipient(friend));
        assertFalse(wallet.isTargetAllowed(address(shop)));
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
        wallet.executeWithSig(friend, 0.25 ether, "", deadline, 0, sig);
        assertEq(friend.balance, 0.25 ether);
        // The same signature cannot be used twice: the nonce moved on.
        vm.prank(relayer);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 0.25 ether, "", deadline, 0, sig);
    }

    function testSignedCallsFollowTheRulesToo() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _sign(selfPk, friend, 2 ether, "", 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.OverTxCap.selector, 2 ether, 1 ether));
        wallet.executeWithSig(friend, 2 ether, "", deadline, 0, sig);
    }

    function testSignedCallsFromAnotherKeyOrTooLateFail() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory wrong = _sign(0xBAD, friend, 1, "", 0, deadline);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 1, "", deadline, 0, wrong);
        bytes memory late = _sign(selfPk, friend, 1, "", 0, block.timestamp - 1);
        vm.expectRevert(SigilSelfWallet.Expired.selector);
        wallet.executeWithSig(friend, 1, "", block.timestamp - 1, 0, late);
        // A signature over other data does not fit this call.
        bytes memory other = _sign(selfPk, friend, 2, "", 0, deadline);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 1, "", deadline, 0, other);
    }

    function testHighSSignaturesAreRefused() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = wallet.executeDigest(friend, 1, "", 0, deadline, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(selfPk, digest);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 1, "", deadline, 0, flipped);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 1, "", deadline, 0, hex"1234");
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
        wallet.setRecipient(stranger, true);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.configure(1, 1, 0, new address[](0), new address[](0), new SigilSelfWallet.SelectorRule[](0), new SigilSelfWallet.TokenLimit[](0));
        vm.expectRevert(SigilSelfWallet.NotOwnerOrSelf.selector);
        wallet.revokeApprovals();
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

    // ---------------------------------------------------------------- the shared vector

    /// Same values as the executeDigest vector in docs/spec/vectors.json, made by packages/core: the
    /// self key signs order(3) with 100000 gas on the device, a relayer submits it, and the wallet runs it.
    function testVectorFromTypeScript() public {
        address at = 0x00000000000000000000000000000000005E1F02;
        address vectorSelf = 0xDAD7d47b8899670E5A6c1A7338e006Ea89e4e923;
        address shopAt = 0x2222222222222222222222222222222222222222;
        vm.chainId(1);
        deployCodeTo("SigilSelfWallet.sol:SigilSelfWallet", abi.encode(owner, vectorSelf), at);
        deployCodeTo("SigilSelfWallet.t.sol:Shop", shopAt);
        SigilSelfWallet w = SigilSelfWallet(payable(at));
        bytes memory data = hex"21603f430000000000000000000000000000000000000000000000000000000000000003";
        assertEq(w.executeDigest(shopAt, 0, data, 0, 1_900_000_000, 100_000), 0xf9e06715a08cac392c0b6ecb20f1093af01c2551ac6b21725e2ca37962ac475b);
        address[] memory targets = new address[](1);
        targets[0] = shopAt;
        SigilSelfWallet.SelectorRule[] memory sels = new SigilSelfWallet.SelectorRule[](1);
        sels[0] = SigilSelfWallet.SelectorRule(shopAt, ORDER);
        vm.prank(owner);
        w.configure(0, 0, 0, new address[](0), targets, sels, new SigilSelfWallet.TokenLimit[](0));
        vm.prank(relayer);
        w.executeWithSig(
            shopAt,
            0,
            data,
            1_900_000_000,
            100_000,
            hex"4788b9bb807b9d67b86782501dc5ddddc08cf6835b56b0c2df1064703d673fd77c6e03aaab6374472730b020835fc4767fd833fb232480abbfced96258f5b5a61b"
        );
        assertEq(Shop(shopAt).orders(), 3);
    }

    /// The walletRules vector's configure() call data, made by packages/core from the vault's rules,
    /// sets exactly the rules the vault shows: recipients apart from contracts and tokens.
    function testConfigureVectorFromTypeScript() public {
        vm.prank(owner);
        (bool ok,) = address(wallet).call(hex"c2dd807700000000000000000000000000000000000000000000000000b1a2bc2ec5000000000000000000000000000000000000000000000000000002c68af0bb140000000000000000000000000000000000000000000000000000000000006bfdff0000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000000100000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000002000000000000000000000000222222222222222222222222222222222222222200000000000000000000000033333333333333333333333333333333333333330000000000000000000000000000000000000000000000000000000000000003000000000000000000000000222222222222222222222222222222222222222221603f43000000000000000000000000000000000000000000000000000000000000000000000000000000003333333333333333333333333333333333333333a9059cbb000000000000000000000000000000000000000000000000000000000000000000000000000000003333333333333333333333333333333333333333095ea7b300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000033333333333333333333333333333333333333330000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000000000000000000000000000000000000ee6b280");
        assertTrue(ok);
        address friendAt = 0x1111111111111111111111111111111111111111;
        address shopAt = 0x2222222222222222222222222222222222222222;
        address tokenAt = 0x3333333333333333333333333333333333333333;
        assertEq(wallet.perTxCap(), 0.05 ether);
        assertEq(wallet.perDayCap(), 0.2 ether);
        assertEq(wallet.expiresAt(), 1_811_808_000);
        assertTrue(wallet.isRecipient(friendAt));
        assertFalse(wallet.isTargetAllowed(friendAt));
        assertTrue(wallet.isTargetAllowed(shopAt) && wallet.isTargetAllowed(tokenAt));
        assertFalse(wallet.isRecipient(shopAt) || wallet.isRecipient(tokenAt));
        assertTrue(wallet.isSelectorAllowed(shopAt, ORDER));
        assertTrue(wallet.isSelectorAllowed(tokenAt, TestToken.transfer.selector));
        (uint128 perTx, uint128 perDay) = wallet.tokenLimit(tokenAt);
        assertEq(perTx, 100e6);
        assertEq(perDay, 250e6);
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
        wallet.executeWithSig(friend, value, data, deadline, 0, sig);
        assertEq(wallet.nonce(), 0);
        vm.prank(owner);
        wallet.withdraw(payable(owner), 1 ether);
        assertEq(owner.balance, 1 ether);
    }

    /// Any target that is not on the list is refused, whatever the call.
    function testFuzzUnlistedTargetsAreRefused(address target, uint64 value, bytes calldata data) public {
        vm.assume(target != friend && target != address(shop) && target != address(token) && target != address(wallet));
        vm.prank(selfKey);
        // A call with no data goes only to recipients; a call with data only to listed contracts.
        if (data.length == 0) vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.RecipientNotAllowed.selector, target));
        else vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.TargetNotAllowed.selector, target));
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

    // ---------------------------------------------------------------- round eight: review fixes

    function testOtherFunctionsOfACappedTokenAreRefusedEvenWhenAllowed() public {
        // The owner allowed transferAndCall on the token by mistake: it would move the token around its caps.
        vm.prank(owner);
        wallet.setSelector(address(token), TestToken.transferAndCall.selector, true);
        bytes memory data = abi.encodeWithSelector(TestToken.transferAndCall.selector, friend, 1_000e18, "");
        vm.prank(selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfWallet.TokenMoveRefused.selector, TestToken.transferAndCall.selector));
        wallet.execute(address(token), 0, data);
        assertEq(token.balanceOf(friend), 0);
    }

    function testTheOwnerCancelsSignedCalls() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(selfPk, friend, 0.25 ether, "", 0, deadline);
        vm.prank(owner);
        wallet.cancelSignedCalls();
        assertEq(wallet.nonce(), 1);
        vm.prank(relayer);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 0.25 ether, "", deadline, 0, sig);
        assertEq(friend.balance, 0);
        // Only the owner may cancel.
        vm.prank(selfKey);
        vm.expectRevert(SigilSelfWallet.NotOwner.selector);
        wallet.cancelSignedCalls();
    }

    function testUnfreezingCancelsCallsSignedBefore() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(selfPk, friend, 0.25 ether, "", 0, deadline);
        vm.prank(owner);
        wallet.freeze();
        vm.prank(owner);
        wallet.unfreeze();
        vm.prank(relayer);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, 0.25 ether, "", deadline, 0, sig);
    }

    function testFuzzASignatureWorksOnceOnlyAndNotInItsOtherForm(uint64 amount) public {
        amount = uint64(bound(amount, 1, 1 ether));
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = wallet.executeDigest(friend, amount, "", 0, deadline, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(selfPk, digest);
        // The malleable twin (r, n - s, other v) is refused.
        bytes32 twinS = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, amount, "", deadline, 0, abi.encodePacked(r, twinS, v == 27 ? uint8(28) : uint8(27)));
        bytes memory sig = abi.encodePacked(r, s, v);
        wallet.executeWithSig(friend, amount, "", deadline, 0, sig);
        assertEq(friend.balance, amount);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, amount, "", deadline, 0, sig);
        // The same signature on another chain fails too.
        vm.chainId(block.chainid + 1);
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, amount, "", deadline, 0, sig);
    }

    function testFuzzRandomSignaturesNeverPass(bytes32 r, bytes32 s, uint8 v, uint64 amount) public {
        vm.assume(uint256(r) != 0);
        uint256 deadline = block.timestamp + 1 hours;
        vm.expectRevert(SigilSelfWallet.BadSignature.selector);
        wallet.executeWithSig(friend, uint256(amount) % 1 ether, "", deadline, 0, abi.encodePacked(r, s, v));
    }
}
