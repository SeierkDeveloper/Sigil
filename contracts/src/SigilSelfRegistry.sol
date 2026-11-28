// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SigilSelfRegistry
/// @notice A public record of AI selves: which owner address stands behind a self key,
///         where its metadata lives, which wallet it may use, and whether it was revoked.
/// @dev The self key is an ordinary secp256k1 key derived on the owner's device from the
///      vault key. Registering needs both sides: the owner sends the transaction, and the
///      self key signs an EIP-712 message that names that owner, so neither can claim the
///      other alone. Handing the identity to a new owner needs both sides too: the owner
///      proposes, and the new owner accepts with a call of its own (or the owner cancels).
///      On acceptance the wallet entry is cleared, so a claim is never inherited.
///      A revoked self key stays revoked and can never be registered again.
///      The same EIP-712 digest is computed in packages/core/src/identity.ts.
contract SigilSelfRegistry {
    struct Identity {
        address owner;
        address wallet;
        uint64 registeredAt;
        uint64 revokedAt;
        string metadataURI;
    }

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant REGISTER_TYPEHASH =
        keccak256("Register(address owner,address selfKey,string metadataURI,uint256 deadline)");
    bytes32 private constant NAME_HASH = keccak256("SigilSelfRegistry");
    bytes32 private constant VERSION_HASH = keccak256("1");
    /// @dev Half the order of secp256k1: signatures with a higher s are refused (EIP-2).
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 public constant MAX_URI_BYTES = 512;

    mapping(address selfKey => Identity) private _identities;
    /// @notice How many selves each owner registered or accepted (revoked ones included).
    mapping(address owner => uint256) public registeredBy;
    /// @notice The owner a self key is being handed to, until that owner accepts. Zero when none.
    mapping(address selfKey => address) public pendingOwner;

    event Registered(address indexed selfKey, address indexed owner, string metadataURI);
    event MetadataChanged(address indexed selfKey, string metadataURI);
    event WalletChanged(address indexed selfKey, address indexed wallet);
    event OwnerChanged(address indexed selfKey, address indexed previousOwner, address indexed newOwner);
    event TransferProposed(address indexed selfKey, address indexed owner, address indexed newOwner);
    event TransferCancelled(address indexed selfKey, address indexed newOwner);
    event Revoked(address indexed selfKey, address indexed by);

    error ZeroAddress();
    error AlreadyRegistered(address selfKey);
    error NotRegistered(address selfKey);
    error IsRevoked(address selfKey);
    error NotOwner();
    error NotOwnerOrSelf();
    error Expired();
    error BadSignature();
    error UriTooLong();
    error NotPendingOwner();
    error MetadataNotAsOffered();
    error TransferPending(address selfKey);
    error AlreadyOwner();

    modifier onlyIdentityOwner(address selfKey) {
        Identity storage id = _identities[selfKey];
        if (id.owner == address(0)) revert NotRegistered(selfKey);
        if (id.owner != msg.sender) revert NotOwner();
        if (id.revokedAt != 0) revert IsRevoked(selfKey);
        _;
    }

    // ------------------------------------------------------------------ writes

    /// @notice Registers a self key under the sender as its owner.
    /// @param selfKey The address of the self key.
    /// @param metadataURI Where the self's signed identity statement can be read.
    /// @param deadline The signature is only good until this time.
    /// @param selfSignature The self key's EIP-712 signature over Register(owner, selfKey, metadataURI, deadline).
    function register(address selfKey, string calldata metadataURI, uint256 deadline, bytes calldata selfSignature) external {
        if (selfKey == address(0)) revert ZeroAddress();
        if (bytes(metadataURI).length > MAX_URI_BYTES) revert UriTooLong();
        if (block.timestamp > deadline) revert Expired();
        if (_identities[selfKey].owner != address(0)) revert AlreadyRegistered(selfKey);
        bytes32 digest = registerDigest(msg.sender, selfKey, metadataURI, deadline);
        if (_recover(digest, selfSignature) != selfKey) revert BadSignature();
        _identities[selfKey] = Identity({owner: msg.sender, wallet: address(0), registeredAt: uint64(block.timestamp), revokedAt: 0, metadataURI: metadataURI});
        unchecked {
            registeredBy[msg.sender]++;
        }
        emit Registered(selfKey, msg.sender, metadataURI);
    }

    /// @notice Changes where the identity statement lives. Refused while a transfer is pending,
    ///         so the new owner accepts exactly the metadata that was there when it was offered.
    function setMetadata(address selfKey, string calldata metadataURI) external onlyIdentityOwner(selfKey) {
        if (pendingOwner[selfKey] != address(0)) revert TransferPending(selfKey);
        if (bytes(metadataURI).length > MAX_URI_BYTES) revert UriTooLong();
        _identities[selfKey].metadataURI = metadataURI;
        emit MetadataChanged(selfKey, metadataURI);
    }

    /// @notice Names the wallet this self acts through. Zero clears it.
    function setWallet(address selfKey, address wallet) external onlyIdentityOwner(selfKey) {
        _identities[selfKey].wallet = wallet;
        emit WalletChanged(selfKey, wallet);
    }

    /// @notice Proposes a new owner. Nothing changes until that owner calls acceptIdentity.
    ///         A new proposal replaces the last one; zero is refused (use cancelTransfer), and so is
    ///         the current owner, which would only move registeredBy.
    function transferIdentity(address selfKey, address newOwner) external onlyIdentityOwner(selfKey) {
        if (newOwner == address(0)) revert ZeroAddress();
        if (newOwner == msg.sender) revert AlreadyOwner();
        pendingOwner[selfKey] = newOwner;
        emit TransferProposed(selfKey, msg.sender, newOwner);
    }

    /// @notice Withdraws a proposal that was not accepted yet.
    function cancelTransfer(address selfKey) external onlyIdentityOwner(selfKey) {
        address pending = pendingOwner[selfKey];
        delete pendingOwner[selfKey];
        emit TransferCancelled(selfKey, pending);
    }

    /// @notice The proposed owner takes the identity. The wallet entry is cleared: the new
    ///         owner names its own. The metadata stays until the new owner changes it.
    /// @param expectedMetadataHash keccak256 of the metadata URI the new owner saw when it accepted.
    ///        If the current owner changed it in between (cancel, change, offer again), the accept fails.
    function acceptIdentity(address selfKey, bytes32 expectedMetadataHash) external {
        Identity storage id = _identities[selfKey];
        if (id.owner == address(0)) revert NotRegistered(selfKey);
        if (id.revokedAt != 0) revert IsRevoked(selfKey);
        address pending = pendingOwner[selfKey];
        if (pending == address(0) || pending != msg.sender) revert NotPendingOwner();
        if (keccak256(bytes(id.metadataURI)) != expectedMetadataHash) revert MetadataNotAsOffered();
        delete pendingOwner[selfKey];
        address previous = id.owner;
        id.owner = msg.sender;
        if (id.wallet != address(0)) {
            id.wallet = address(0);
            emit WalletChanged(selfKey, address(0));
        }
        unchecked {
            registeredBy[msg.sender]++;
        }
        emit OwnerChanged(selfKey, previous, msg.sender);
    }

    /// @notice Revokes a self key for good. The owner can, and so can the self key itself.
    function revoke(address selfKey) external {
        Identity storage id = _identities[selfKey];
        if (id.owner == address(0)) revert NotRegistered(selfKey);
        if (msg.sender != id.owner && msg.sender != selfKey) revert NotOwnerOrSelf();
        if (id.revokedAt != 0) revert IsRevoked(selfKey);
        id.revokedAt = uint64(block.timestamp);
        delete pendingOwner[selfKey];
        emit Revoked(selfKey, msg.sender);
    }

    // ------------------------------------------------------------------ reads

    function identityOf(address selfKey) external view returns (Identity memory) {
        return _identities[selfKey];
    }

    function isActive(address selfKey) external view returns (bool) {
        Identity storage id = _identities[selfKey];
        return id.owner != address(0) && id.revokedAt == 0;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function registerDigest(address owner, address selfKey, string calldata metadataURI, uint256 deadline) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(REGISTER_TYPEHASH, owner, selfKey, keccak256(bytes(metadataURI)), deadline));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    // ------------------------------------------------------------------ internal

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
