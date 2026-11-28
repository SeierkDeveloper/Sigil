// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SigilSelfRegistry} from "../src/SigilSelfRegistry.sol";

contract SigilSelfRegistryTest is Test {
    SigilSelfRegistry internal registry;
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    uint256 internal selfPk = 0x5E1F;
    address internal selfKey;
    string internal constant URI = "https://example.org/api/identity/self";

    event Registered(address indexed selfKey, address indexed owner, string metadataURI);

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new SigilSelfRegistry();
        selfKey = vm.addr(selfPk);
    }

    function _sig(uint256 pk, address forOwner, address key, string memory uri, uint256 deadline) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, registry.registerDigest(forOwner, key, uri, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _register() internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(selfPk, owner, selfKey, URI, deadline);
        vm.prank(owner);
        registry.register(selfKey, URI, deadline, sig);
    }

    // ---------------------------------------------------------------- registering

    function testRegisterRecordsOwnerKeyAndMetadata() public {
        vm.expectEmit(true, true, false, true);
        emit Registered(selfKey, owner, URI);
        _register();
        SigilSelfRegistry.Identity memory id = registry.identityOf(selfKey);
        assertEq(id.owner, owner);
        assertEq(id.metadataURI, URI);
        assertEq(id.registeredAt, block.timestamp);
        assertEq(id.revokedAt, 0);
        assertEq(id.wallet, address(0));
        assertTrue(registry.isActive(selfKey));
        assertEq(registry.registeredBy(owner), 1);
    }

    function testTheSelfKeyMustAgree() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory other = _sig(0xBAD, owner, selfKey, URI, deadline);
        vm.prank(owner);
        vm.expectRevert(SigilSelfRegistry.BadSignature.selector);
        registry.register(selfKey, URI, deadline, other);
    }

    function testASignatureForOneOwnerCannotBeUsedByAnother() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(selfPk, owner, selfKey, URI, deadline);
        vm.prank(stranger);
        vm.expectRevert(SigilSelfRegistry.BadSignature.selector);
        registry.register(selfKey, URI, deadline, sig);
    }

    function testTheSignatureCoversTheMetadata() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(selfPk, owner, selfKey, URI, deadline);
        vm.prank(owner);
        vm.expectRevert(SigilSelfRegistry.BadSignature.selector);
        registry.register(selfKey, "https://elsewhere.example/x", deadline, sig);
    }

    function testExpiredSignaturesAreRefused() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _sig(selfPk, owner, selfKey, URI, deadline);
        vm.prank(owner);
        vm.expectRevert(SigilSelfRegistry.Expired.selector);
        registry.register(selfKey, URI, deadline, sig);
    }

    function testRegisteringTwiceFails() public {
        _register();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(selfPk, stranger, selfKey, URI, deadline);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfRegistry.AlreadyRegistered.selector, selfKey));
        registry.register(selfKey, URI, deadline, sig);
    }

    function testZeroKeyLongUriAndBadSignatureShapes() public {
        vm.expectRevert(SigilSelfRegistry.ZeroAddress.selector);
        registry.register(address(0), URI, block.timestamp, "");
        bytes memory long = new bytes(513);
        vm.expectRevert(SigilSelfRegistry.UriTooLong.selector);
        registry.register(selfKey, string(long), block.timestamp, "");
        vm.prank(owner);
        vm.expectRevert(SigilSelfRegistry.BadSignature.selector);
        registry.register(selfKey, URI, block.timestamp, hex"00");
        // The same signature with a high s is refused.
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(selfPk, registry.registerDigest(owner, selfKey, URI, deadline));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(owner);
        vm.expectRevert(SigilSelfRegistry.BadSignature.selector);
        registry.register(selfKey, URI, deadline, flipped);
    }

    // ---------------------------------------------------------------- changes by the owner

    function testOwnerChangesMetadataAndWallet() public {
        _register();
        address wallet = makeAddr("wallet");
        vm.startPrank(owner);
        registry.setMetadata(selfKey, "https://example.org/v2");
        registry.setWallet(selfKey, wallet);
        vm.stopPrank();
        SigilSelfRegistry.Identity memory id = registry.identityOf(selfKey);
        assertEq(id.metadataURI, "https://example.org/v2");
        assertEq(id.wallet, wallet);
    }

    function testOnlyTheOwnerChangesAnything() public {
        _register();
        vm.startPrank(stranger);
        vm.expectRevert(SigilSelfRegistry.NotOwner.selector);
        registry.setMetadata(selfKey, "x");
        vm.expectRevert(SigilSelfRegistry.NotOwner.selector);
        registry.setWallet(selfKey, stranger);
        vm.expectRevert(SigilSelfRegistry.NotOwner.selector);
        registry.transferIdentity(selfKey, stranger);
        vm.expectRevert(SigilSelfRegistry.NotOwnerOrSelf.selector);
        registry.revoke(selfKey);
        vm.stopPrank();
        // The self key cannot change its own record either, only revoke it.
        vm.prank(selfKey);
        vm.expectRevert(SigilSelfRegistry.NotOwner.selector);
        registry.setWallet(selfKey, selfKey);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfRegistry.NotRegistered.selector, stranger));
        registry.setMetadata(stranger, "x");
    }

    function testTransferIdentityTakesTwoSteps() public {
        _register();
        vm.prank(owner);
        registry.setWallet(selfKey, address(0xBEEF));
        vm.prank(owner);
        registry.transferIdentity(selfKey, stranger);
        // Only proposed: the owner is still the owner.
        assertEq(registry.identityOf(selfKey).owner, owner);
        assertEq(registry.pendingOwner(selfKey), stranger);
        vm.prank(stranger);
        registry.acceptIdentity(selfKey, keccak256(bytes(URI)));
        SigilSelfRegistry.Identity memory id = registry.identityOf(selfKey);
        assertEq(id.owner, stranger);
        assertEq(id.wallet, address(0));
        assertEq(registry.registeredBy(stranger), 1);
        vm.prank(owner);
        vm.expectRevert(SigilSelfRegistry.NotOwner.selector);
        registry.setMetadata(selfKey, "x");
        vm.prank(stranger);
        vm.expectRevert(SigilSelfRegistry.ZeroAddress.selector);
        registry.transferIdentity(selfKey, address(0));
        // Accepting twice does nothing more: nothing is pending.
        vm.prank(stranger);
        vm.expectRevert(SigilSelfRegistry.NotPendingOwner.selector);
        registry.acceptIdentity(selfKey, keccak256(bytes(URI)));
    }

    /// N-5: while a transfer is pending the metadata cannot change, so the new owner accepts what
    /// was offered; and the current owner cannot propose the identity to itself.
    function testMetadataIsHeldWhileATransferIsPendingAndNoTransferToSelf() public {
        _register();
        string memory before = registry.identityOf(selfKey).metadataURI;
        vm.prank(owner);
        vm.expectRevert(SigilSelfRegistry.AlreadyOwner.selector);
        registry.transferIdentity(selfKey, owner);
        vm.prank(owner);
        registry.transferIdentity(selfKey, stranger);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfRegistry.TransferPending.selector, selfKey));
        registry.setMetadata(selfKey, "ipfs://changed");
        vm.prank(stranger);
        registry.acceptIdentity(selfKey, keccak256(bytes(URI)));
        assertEq(registry.identityOf(selfKey).metadataURI, before);
        // After a cancel the owner can change it again.
        vm.prank(stranger);
        registry.transferIdentity(selfKey, owner);
        vm.prank(stranger);
        registry.cancelTransfer(selfKey);
        vm.prank(stranger);
        registry.setMetadata(selfKey, "ipfs://new");
        assertEq(registry.identityOf(selfKey).metadataURI, "ipfs://new");
    }

    function testAProposalCanBeCancelledOrReplaced() public {
        _register();
        address other = makeAddr("other");
        vm.startPrank(owner);
        registry.transferIdentity(selfKey, stranger);
        registry.transferIdentity(selfKey, other);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(SigilSelfRegistry.NotPendingOwner.selector);
        registry.acceptIdentity(selfKey, keccak256(bytes(URI)));
        vm.prank(owner);
        registry.cancelTransfer(selfKey);
        vm.prank(other);
        vm.expectRevert(SigilSelfRegistry.NotPendingOwner.selector);
        registry.acceptIdentity(selfKey, keccak256(bytes(URI)));
        assertEq(registry.identityOf(selfKey).owner, owner);
        // Only the owner proposes or cancels.
        vm.prank(stranger);
        vm.expectRevert(SigilSelfRegistry.NotOwner.selector);
        registry.cancelTransfer(selfKey);
    }

    function testARevokedIdentityCannotBeAccepted() public {
        _register();
        vm.prank(owner);
        registry.transferIdentity(selfKey, stranger);
        vm.prank(selfKey);
        registry.revoke(selfKey);
        assertEq(registry.pendingOwner(selfKey), address(0));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfRegistry.IsRevoked.selector, selfKey));
        registry.acceptIdentity(selfKey, keccak256(bytes(URI)));
    }

    function testFuzzOnlyTheProposedOwnerAccepts(address who) public {
        vm.assume(who != stranger);
        _register();
        vm.prank(owner);
        registry.transferIdentity(selfKey, stranger);
        vm.prank(who);
        vm.expectRevert(SigilSelfRegistry.NotPendingOwner.selector);
        registry.acceptIdentity(selfKey, keccak256(bytes(URI)));
        assertEq(registry.identityOf(selfKey).owner, owner);
    }

    // ---------------------------------------------------------------- revocation

    function testOwnerRevokesForGood() public {
        _register();
        vm.prank(owner);
        registry.revoke(selfKey);
        assertFalse(registry.isActive(selfKey));
        assertEq(registry.identityOf(selfKey).revokedAt, block.timestamp);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfRegistry.IsRevoked.selector, selfKey));
        registry.setMetadata(selfKey, "x");
        vm.expectRevert(abi.encodeWithSelector(SigilSelfRegistry.IsRevoked.selector, selfKey));
        registry.revoke(selfKey);
        vm.stopPrank();
        // A revoked key can never be registered again, by anyone.
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(selfPk, owner, selfKey, URI, deadline);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SigilSelfRegistry.AlreadyRegistered.selector, selfKey));
        registry.register(selfKey, URI, deadline, sig);
    }

    function testTheSelfKeyCanRevokeItself() public {
        _register();
        vm.prank(selfKey);
        registry.revoke(selfKey);
        assertFalse(registry.isActive(selfKey));
    }

    function testUnknownKeysAreNotActive(address key) public view {
        assertFalse(registry.isActive(key));
    }

    // ---------------------------------------------------------------- the shared vector

    /// Same values as the registerDigest vector in docs/spec/vectors.json, made by packages/core: the
    /// self key derived from the vault key of the vectors signs on the device, and the contract agrees.
    function testVectorFromTypeScript() public {
        address at = 0x00000000000000000000000000000000005E1F01;
        address vectorOwner = 0x000000000000000000000000000000000000dEaD;
        address vectorSelf = 0xDAD7d47b8899670E5A6c1A7338e006Ea89e4e923;
        string memory uri = "https://vault.example/api/identity/at/self";
        vm.chainId(1);
        deployCodeTo("SigilSelfRegistry.sol:SigilSelfRegistry", at);
        SigilSelfRegistry r = SigilSelfRegistry(at);
        assertEq(r.registerDigest(vectorOwner, vectorSelf, uri, 1_900_000_000), 0xfbcf4ca8f5c49a225326b9578da080895e4853b0f6e005663362e7a89bda1dac);
        vm.prank(vectorOwner);
        r.register(
            vectorSelf,
            uri,
            1_900_000_000,
            hex"952cb60d8beeb3f873e33855af41b3eacf02e3695cb0df598f9df83f60faa37f56d5924dd48057d92dddf371fb1c1aa623826da74a23c09307e489e537ce291f1c"
        );
        assertEq(r.identityOf(vectorSelf).owner, vectorOwner);
    }

    // ---------------------------------------------------------------- fuzzing

    /// Any key, any owner, any metadata: the pair registers only with the key's own signature for that owner.
    function testFuzzRegisterNeedsTheKeysOwnSignature(uint256 pkSeed, uint256 otherSeed, address who, string calldata uri) public {
        vm.assume(who != address(0) && bytes(uri).length <= 512);
        uint256 pk = bound(pkSeed, 1, 1e70);
        uint256 other = bound(otherSeed, 1, 1e70);
        vm.assume(pk != other);
        address key = vm.addr(pk);
        uint256 deadline = block.timestamp + 1;
        bytes memory wrong = _sig(other, who, key, uri, deadline);
        vm.prank(who);
        vm.expectRevert(SigilSelfRegistry.BadSignature.selector);
        registry.register(key, uri, deadline, wrong);
        bytes memory right = _sig(pk, who, key, uri, deadline);
        vm.prank(who);
        registry.register(key, uri, deadline, right);
        assertEq(registry.identityOf(key).owner, who);
        assertTrue(registry.isActive(key));
    }
}
