// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SigilSeal
/// @notice Public record of Sigil's hourly read-log seals.
/// @dev Every hour the Sigil server builds a Merkle tree over that hour's read-log
///      leaves and anyone can check an entry against the root stored here.
///      A leaf is sha256(0x00 || data) where data includes a random salt that only
///      the account owner can see, so the roots reveal nothing about who read what.
///      Nodes are sha256(0x01 || min(a, b) || max(a, b)); an odd node moves up as is.
///      The same rules are implemented in packages/core/src/merkle.ts.
contract SigilSeal {
    struct Seal {
        bytes32 root;
        /// @dev What the sealer says the tree holds. The contract cannot check it against the
        ///      root, so a reader must not rely on it as a count; only proofs against the root count.
        uint32 leaves;
        uint64 sealedAt;
    }

    uint256 public constant HOUR = 3600;

    address public owner;
    address public sealer;
    /// @notice The highest hour that has a seal.
    uint64 public latestHour;
    /// @notice How many hours have been sealed in total.
    uint64 public sealCount;

    mapping(uint64 hour => Seal) private _seals;

    event Sealed(uint64 indexed hour, bytes32 root, uint32 leaves);
    event SealerChanged(address indexed previousSealer, address indexed newSealer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotSealer();
    error ZeroAddress();
    error ZeroRoot();
    error EmptySeal();
    error HourNotOver(uint64 hour);
    error AlreadySealed(uint64 hour);
    error LengthMismatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlySealer() {
        if (msg.sender != sealer) revert NotSealer();
        _;
    }

    constructor(address initialSealer) {
        if (initialSealer == address(0)) revert ZeroAddress();
        owner = msg.sender;
        sealer = initialSealer;
        emit OwnershipTransferred(address(0), msg.sender);
        emit SealerChanged(address(0), initialSealer);
    }

    // ------------------------------------------------------------------ writes

    /// @notice Records the root of one finished hour. A seal can never be changed.
    /// @param hour Unix time divided by 3600, rounded down.
    /// @param leaves The number of entries, as the sealer states it; not checked against the root.
    function seal(uint64 hour, bytes32 root, uint32 leaves) external onlySealer {
        _seal(hour, root, leaves);
    }

    /// @notice Records several finished hours at once, for when the sealing job catches up.
    function sealMany(uint64[] calldata hours_, bytes32[] calldata roots, uint32[] calldata leaves) external onlySealer {
        if (hours_.length != roots.length || hours_.length != leaves.length) revert LengthMismatch();
        for (uint256 i = 0; i < hours_.length; i++) {
            _seal(hours_[i], roots[i], leaves[i]);
        }
    }

    function setSealer(address newSealer) external onlyOwner {
        if (newSealer == address(0)) revert ZeroAddress();
        emit SealerChanged(sealer, newSealer);
        sealer = newSealer;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------------ reads

    function sealOf(uint64 hour) external view returns (Seal memory) {
        return _seals[hour];
    }

    function isSealed(uint64 hour) public view returns (bool) {
        return _seals[hour].root != bytes32(0);
    }

    /// @notice True when `leaf` (already hashed as sha256(0x00 || data)) is part of the seal for `hour`.
    ///         The caller must hash the leaf itself: an inner node passed here also verifies. See verifyData.
    function verify(uint64 hour, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = _seals[hour].root;
        return root != bytes32(0) && computeRoot(leaf, proof) == root;
    }

    /// @notice True when the entry `data` is part of the seal for `hour`. The leaf is hashed here,
    ///         so an inner node of the tree (or the root itself) passed as a leaf never verifies.
    ///         Prefer this to `verify`, which takes a leaf already hashed by the caller.
    function verifyData(uint64 hour, bytes calldata data, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = _seals[hour].root;
        return root != bytes32(0) && computeRoot(sha256(abi.encodePacked(bytes1(0x00), data)), proof) == root;
    }

    function computeRoot(bytes32 leaf, bytes32[] calldata proof) public pure returns (bytes32 node) {
        node = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            node = nodeHash(node, proof[i]);
        }
    }

    function leafHash(bytes calldata data) external pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x00), data));
    }

    function nodeHash(bytes32 a, bytes32 b) public pure returns (bytes32) {
        return a <= b ? sha256(abi.encodePacked(bytes1(0x01), a, b)) : sha256(abi.encodePacked(bytes1(0x01), b, a));
    }

    // ------------------------------------------------------------------ internal

    function _seal(uint64 hour, bytes32 root, uint32 leaves) private {
        if (root == bytes32(0)) revert ZeroRoot();
        if (leaves == 0) revert EmptySeal();
        if ((uint256(hour) + 1) * HOUR > block.timestamp) revert HourNotOver(hour);
        if (_seals[hour].root != bytes32(0)) revert AlreadySealed(hour);
        _seals[hour] = Seal({root: root, leaves: leaves, sealedAt: uint64(block.timestamp)});
        if (hour > latestHour) latestHour = hour;
        unchecked {
            sealCount++;
        }
        emit Sealed(hour, root, leaves);
    }
}
