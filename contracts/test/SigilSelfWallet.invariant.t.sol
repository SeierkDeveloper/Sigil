// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SigilSelfWallet} from "../src/SigilSelfWallet.sol";

/// Drives the wallet the way a self key and its owner might: payments of any
/// size, signed or sent directly, hours and days passing, rules made tighter.
/// Records what actually left the wallet per UTC day.
contract WalletHandler is Test {
    SigilSelfWallet public wallet;
    uint256 internal selfPk;
    address public friend;
    uint256 public maxPerTx;
    uint256 public maxPerDay;
    mapping(uint256 day => uint256 sent) public sentOnDay;
    uint256[] public days_;
    uint256 public biggestSingle;

    constructor(SigilSelfWallet wallet_, uint256 selfPk_, address friend_, uint256 perTx, uint256 perDay) {
        wallet = wallet_;
        selfPk = selfPk_;
        friend = friend_;
        maxPerTx = perTx;
        maxPerDay = perDay;
    }

    function _record(uint256 value) internal {
        uint256 day = block.timestamp / 1 days;
        if (sentOnDay[day] == 0) days_.push(day);
        sentOnDay[day] += value;
        if (value > biggestSingle) biggestSingle = value;
    }

    function pay(uint96 value) external {
        uint256 before = friend.balance;
        vm.prank(vm.addr(selfPk));
        try wallet.execute(friend, value, "") {
            _record(friend.balance - before);
        } catch {}
    }

    function paySigned(uint96 value) external {
        uint256 before = friend.balance;
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = wallet.executeDigest(friend, value, "", wallet.nonce(), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(selfPk, digest);
        try wallet.executeWithSig(friend, value, "", deadline, abi.encodePacked(r, s, v)) {
            _record(friend.balance - before);
        } catch {}
    }

    function wait(uint32 secondsLater) external {
        vm.warp(block.timestamp + (secondsLater % 2 days));
    }

    function tighten(uint96 perTx, uint96 perDay) external {
        // The owner may lower caps at any time; the invariant holds against the highest caps ever set.
        uint256 t = uint256(perTx) % (maxPerTx + 1);
        uint256 d = uint256(perDay) % (maxPerDay + 1);
        vm.prank(wallet.owner());
        wallet.setLimits(t, d, 0);
    }

    function dayCount() external view returns (uint256) {
        return days_.length;
    }
}

contract SigilSelfWalletInvariantTest is Test {
    SigilSelfWallet internal wallet;
    WalletHandler internal handler;
    address internal owner = makeAddr("owner");
    address internal friend = makeAddr("friend");
    uint256 internal constant SELF_PK = 0xA11CE;
    uint256 internal constant PER_TX = 1 ether;
    uint256 internal constant PER_DAY = 3 ether;

    function setUp() public {
        vm.warp(1_800_000_000);
        wallet = new SigilSelfWallet(owner, vm.addr(SELF_PK));
        vm.deal(address(wallet), 1_000 ether);
        address[] memory targets = new address[](1);
        targets[0] = friend;
        vm.prank(owner);
        wallet.configure(PER_TX, PER_DAY, 0, targets, new SigilSelfWallet.SelectorRule[](0), new SigilSelfWallet.TokenLimit[](0));
        handler = new WalletHandler(wallet, SELF_PK, friend, PER_TX, PER_DAY);
        targetContract(address(handler));
    }

    /// No single payment ever passes the per-transaction cap.
    function invariant_noPaymentAboveTheTransactionCap() public view {
        assertLe(handler.biggestSingle(), PER_TX);
    }

    /// What left the wallet in any one UTC day never passes the daily cap.
    function invariant_noDayAboveTheDailyCap() public view {
        uint256 n = handler.dayCount();
        for (uint256 i = 0; i < n; i++) assertLe(handler.sentOnDay(handler.days_(i)), PER_DAY);
    }

    /// The wallet's balance only goes down by what the friend received.
    function invariant_balancesAddUp() public view {
        assertEq(address(wallet).balance + friend.balance, 1_000 ether);
    }
}
