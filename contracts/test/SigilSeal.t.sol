// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SigilSeal} from "../src/SigilSeal.sol";

contract SigilSealTest is Test {
    SigilSeal internal seals;
    address internal sealer = makeAddr("sealer");
    address internal stranger = makeAddr("stranger");

    uint64 internal constant HOUR_ID = 493_000; // an hour in the past once we warp

    event Sealed(uint64 indexed hour, bytes32 root, uint32 leaves);

    function setUp() public {
        vm.warp(uint256(HOUR_ID + 10) * 3600);
        seals = new SigilSeal(sealer);
    }

    // ---------------------------------------------------------------- helpers (independent of the contract)

    function _leaf(bytes memory data) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x00), data));
    }

    function _node(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        (bytes32 lo, bytes32 hi) = a <= b ? (a, b) : (b, a);
        return sha256(abi.encodePacked(bytes1(0x01), lo, hi));
    }

    function _root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i = 0; i < level.length; i += 2) {
                next[i / 2] = i + 1 < level.length ? _node(level[i], level[i + 1]) : level[i];
            }
            level = next;
        }
        return level[0];
    }

    function _proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory) {
        bytes32[] memory tmp = new bytes32[](64);
        uint256 n;
        bytes32[] memory level = leaves;
        uint256 i = index;
        while (level.length > 1) {
            uint256 sib = i % 2 == 0 ? i + 1 : i - 1;
            if (sib < level.length) tmp[n++] = level[sib];
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 j = 0; j < level.length; j += 2) {
                next[j / 2] = j + 1 < level.length ? _node(level[j], level[j + 1]) : level[j];
            }
            level = next;
            i /= 2;
        }
        bytes32[] memory out = new bytes32[](n);
        for (uint256 k = 0; k < n; k++) out[k] = tmp[k];
        return out;
    }

    // ---------------------------------------------------------------- sealing

    function testSealStoresRootAndEmits() public {
        bytes32 root = keccak256("root");
        vm.expectEmit(true, false, false, true);
        emit Sealed(HOUR_ID, root, 7);
        vm.prank(sealer);
        seals.seal(HOUR_ID, root, 7);

        SigilSeal.Seal memory s = seals.sealOf(HOUR_ID);
        assertEq(s.root, root);
        assertEq(s.leaves, 7);
        assertEq(s.sealedAt, block.timestamp);
        assertTrue(seals.isSealed(HOUR_ID));
        assertEq(seals.latestHour(), HOUR_ID);
        assertEq(seals.sealCount(), 1);
    }

    function testOnlySealerCanSeal() public {
        vm.prank(stranger);
        vm.expectRevert(SigilSeal.NotSealer.selector);
        seals.seal(HOUR_ID, keccak256("r"), 1);
    }

    function testSealIsPermanent() public {
        vm.startPrank(sealer);
        seals.seal(HOUR_ID, keccak256("r"), 1);
        vm.expectRevert(abi.encodeWithSelector(SigilSeal.AlreadySealed.selector, HOUR_ID));
        seals.seal(HOUR_ID, keccak256("other"), 2);
        vm.stopPrank();
    }

    function testCannotSealAnHourThatIsNotOver() public {
        uint64 current = uint64(block.timestamp / 3600);
        vm.startPrank(sealer);
        vm.expectRevert(abi.encodeWithSelector(SigilSeal.HourNotOver.selector, current));
        seals.seal(current, keccak256("r"), 1);
        vm.expectRevert(abi.encodeWithSelector(SigilSeal.HourNotOver.selector, current + 5));
        seals.seal(current + 5, keccak256("r"), 1);
        seals.seal(current - 1, keccak256("r"), 1);
        vm.stopPrank();
    }

    function testRejectsEmptySeals() public {
        vm.startPrank(sealer);
        vm.expectRevert(SigilSeal.ZeroRoot.selector);
        seals.seal(HOUR_ID, bytes32(0), 1);
        vm.expectRevert(SigilSeal.EmptySeal.selector);
        seals.seal(HOUR_ID, keccak256("r"), 0);
        vm.stopPrank();
    }

    function testSealMany() public {
        uint64[] memory hours_ = new uint64[](3);
        bytes32[] memory roots = new bytes32[](3);
        uint32[] memory counts = new uint32[](3);
        for (uint256 i = 0; i < 3; i++) {
            hours_[i] = HOUR_ID + uint64(i);
            roots[i] = keccak256(abi.encode(i));
            counts[i] = uint32(i + 1);
        }
        vm.prank(sealer);
        seals.sealMany(hours_, roots, counts);
        assertEq(seals.sealCount(), 3);
        assertEq(seals.latestHour(), HOUR_ID + 2);
        assertEq(seals.sealOf(HOUR_ID + 1).root, roots[1]);

        uint32[] memory short = new uint32[](2);
        vm.prank(sealer);
        vm.expectRevert(SigilSeal.LengthMismatch.selector);
        seals.sealMany(hours_, roots, short);
    }

    function testLatestHourOnlyMovesForward() public {
        vm.startPrank(sealer);
        seals.seal(HOUR_ID + 2, keccak256("a"), 1);
        seals.seal(HOUR_ID, keccak256("b"), 1);
        vm.stopPrank();
        assertEq(seals.latestHour(), HOUR_ID + 2);
    }

    // ---------------------------------------------------------------- roles

    function testOwnerChangesSealer() public {
        address next = makeAddr("next");
        seals.setSealer(next);
        assertEq(seals.sealer(), next);

        vm.prank(sealer);
        vm.expectRevert(SigilSeal.NotSealer.selector);
        seals.seal(HOUR_ID, keccak256("r"), 1);

        vm.prank(next);
        seals.seal(HOUR_ID, keccak256("r"), 1);
    }

    function testOnlyOwnerAdministers() public {
        vm.startPrank(stranger);
        vm.expectRevert(SigilSeal.NotOwner.selector);
        seals.setSealer(stranger);
        vm.expectRevert(SigilSeal.NotOwner.selector);
        seals.transferOwnership(stranger);
        vm.stopPrank();
    }

    function testTransferOwnership() public {
        seals.transferOwnership(stranger);
        assertEq(seals.owner(), stranger);
        vm.expectRevert(SigilSeal.NotOwner.selector);
        seals.setSealer(stranger);
    }

    function testZeroAddressesRejected() public {
        vm.expectRevert(SigilSeal.ZeroAddress.selector);
        new SigilSeal(address(0));
        vm.expectRevert(SigilSeal.ZeroAddress.selector);
        seals.setSealer(address(0));
        vm.expectRevert(SigilSeal.ZeroAddress.selector);
        seals.transferOwnership(address(0));
    }

    // ---------------------------------------------------------------- merkle

    /// Same vector as packages/core/test/merkle.test.ts.
    function testVectorFromTypeScript() public {
        bytes32 a = seals.leafHash(bytes("sigil-a"));
        bytes32 b = seals.leafHash(bytes("sigil-b"));
        bytes32 c = seals.leafHash(bytes("sigil-c"));
        assertEq(a, 0x2ec63fa6a5e8a56c9b2eac25efd9293f0d3deee2f757cbc5ebfac68683d0d9c6);
        assertEq(b, 0xb0d262a6efefad4a872e74542e824dc9c0726161e0d6996e77f5c4dc0265793e);
        assertEq(c, 0x2ddf0622ad38d84755f555cfc0d0f8c9cea56d4c4c947243b7680948cb3ae3ab);

        bytes32 root = 0xc23750ad4b065541539f1c35afeddbd1816a73097b8720197308c0dfea7ba41e;
        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = a;
        leaves[1] = b;
        leaves[2] = c;
        assertEq(_root(leaves), root);

        vm.prank(sealer);
        seals.seal(HOUR_ID, root, 3);

        bytes32[] memory proof = new bytes32[](2);
        proof[0] = b;
        proof[1] = c;
        assertTrue(seals.verify(HOUR_ID, a, proof));
        assertTrue(seals.verify(HOUR_ID, c, _proof(leaves, 2)));
        assertFalse(seals.verify(HOUR_ID, b, proof));
        assertFalse(seals.verify(HOUR_ID + 1, a, proof));
    }

    function testNodeHashIsOrderIndependent(bytes32 x, bytes32 y) public view {
        assertEq(seals.nodeHash(x, y), seals.nodeHash(y, x));
    }

    function testFuzzEveryProofVerifies(uint256 seed, uint8 size) public {
        uint256 n = bound(size, 1, 40);
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            leaves[i] = _leaf(abi.encode(seed, i));
        }
        bytes32 root = _root(leaves);
        vm.prank(sealer);
        seals.seal(HOUR_ID, root, uint32(n));
        for (uint256 i = 0; i < n; i++) {
            assertTrue(seals.verify(HOUR_ID, leaves[i], _proof(leaves, i)));
        }
        assertFalse(seals.verify(HOUR_ID, _leaf(abi.encode(seed, n + 1)), _proof(leaves, 0)));
    }

    function testFuzzTamperedProofFails(uint256 seed, uint8 size, uint8 which) public {
        uint256 n = bound(size, 2, 40);
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            leaves[i] = _leaf(abi.encode(seed, i));
        }
        // Compute first: sha256 is a precompile call and would use up the prank.
        bytes32 root = _root(leaves);
        vm.prank(sealer);
        seals.seal(HOUR_ID, root, uint32(n));
        uint256 idx = bound(which, 0, n - 1);
        bytes32[] memory proof = _proof(leaves, idx);
        proof[0] = bytes32(uint256(proof[0]) ^ 1);
        assertFalse(seals.verify(HOUR_ID, leaves[idx], proof));
    }

    // ---------------------------------------------------------------- round eight: entries checked by their data

    function testFuzzVerifyDataTakesEveryEntryAndNoInnerNode(uint256 seed, uint8 size) public {
        uint256 n = bound(size, 2, 32);
        bytes[] memory data = new bytes[](n);
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            data[i] = abi.encode(seed, i);
            leaves[i] = _leaf(data[i]);
        }
        bytes32 root = _root(leaves);
        vm.prank(sealer);
        seals.seal(HOUR_ID, root, uint32(n));
        for (uint256 i = 0; i < n; i++) {
            assertTrue(seals.verifyData(HOUR_ID, data[i], _proof(leaves, i)));
        }
        // An inner node passed as data is hashed as a leaf, so it never leads to the root.
        bytes32 inner = _node(leaves[0], leaves[1]);
        bytes32[] memory rest = _proof(leaves, 0);
        bytes32[] memory up = new bytes32[](rest.length > 0 ? rest.length - 1 : 0);
        for (uint256 i = 0; i < up.length; i++) up[i] = rest[i + 1];
        assertFalse(seals.verifyData(HOUR_ID, abi.encodePacked(inner), up));
        // Nor does the root itself with an empty proof.
        assertFalse(seals.verifyData(HOUR_ID, abi.encodePacked(root), new bytes32[](0)));
        // An hour without a seal verifies nothing.
        assertFalse(seals.verifyData(HOUR_ID + 1, data[0], _proof(leaves, 0)));
    }
}
