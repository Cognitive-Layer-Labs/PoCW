// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IPoCW_SBT {
    function mint(address to, uint256 id, uint256 amount) external;
    function setTokenURI(uint256 id, string calldata uri) external;
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

interface IKAL {
    function mint(address to, uint256 amount) external;
}

/**
 * @title PoCW_Controller
 * @notice Verifies the oracle's EIP-712 attestation, mints a per-holder soulbound token,
 *         and mints the learner's KAL reward — atomically, in one transaction.
 *
 * EIP-712 typed data:
 *   domain  = ("PoCW", "1", chainId, this)
 *   struct  = Attestation(address user,uint256 contentId,uint256 score,uint256 kalAmount,
 *                         uint256 expiry,bytes32 nonce,bytes32 tokenUriHash)
 *
 * Security properties:
 *   - Domain separation: chainId + this contract are bound into the signature (no cross-chain
 *     / cross-deployment replay).
 *   - Replay protection: nonces are marked used on-chain.
 *   - Expiry: signatures are valid for a finite window (oracle sets the TTL).
 *   - Sender check (strictSender=true): only the attested user can submit the tx.
 *   - KAL can ONLY be minted via a signed, expiring, nonce-protected attestation (the controller
 *     is the KAL owner) — there is no unlimited-mint EOA path.
 *
 * Per-holder token id: tokenId = keccak256(user, contentId). Each learner's SBT carries that
 * learner's own metadata; a later minter cannot overwrite an earlier holder's credential.
 */
contract PoCW_Controller is EIP712 {
    using ECDSA for bytes32;

    address public immutable oracleAddress;
    address public immutable sbtContract;
    address public immutable kalToken;
    bool public immutable strictSender;

    mapping(bytes32 => bool) public usedNonces;
    mapping(uint256 => bool) public kalClaimed;

    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address user,uint256 contentId,uint256 score,uint256 kalAmount,uint256 expiry,bytes32 nonce,bytes32 tokenUriHash)"
    );

    error InvalidSignature();
    error SignatureExpired();
    error NonceAlreadyUsed();
    error SenderMismatch();

    event Attested(
        address indexed user,
        uint256 indexed contentId,
        uint256 tokenId,
        uint256 score,
        uint256 kalAmount,
        bytes32 nonce
    );

    constructor(address _oracleAddress, address _sbtContract, address _kalToken, bool _strictSender)
        EIP712("PoCW", "1")
    {
        require(_oracleAddress != address(0), "Invalid oracle");
        require(_sbtContract != address(0), "Invalid SBT");
        require(_kalToken != address(0), "Invalid KAL");
        oracleAddress = _oracleAddress;
        sbtContract = _sbtContract;
        kalToken = _kalToken;
        strictSender = _strictSender;
    }

    /// @notice Deterministic per-holder ERC-1155 token id.
    function sbtTokenId(address user, uint256 contentId) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(user, contentId)));
    }

    /// @notice Recompute the EIP-712 digest for a given attestation (off-chain signing aid / tests).
    function attestationDigest(
        address user,
        uint256 contentId,
        uint256 score,
        uint256 kalAmount,
        uint256 expiry,
        bytes32 nonce,
        string calldata tokenUri
    ) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            ATTESTATION_TYPEHASH, user, contentId, score, kalAmount, expiry, nonce, keccak256(bytes(tokenUri))
        )));
    }

    /**
     * @notice Verify the oracle attestation, then mint the SBT and KAL to `user` atomically.
     * @param user       Address credited (must equal msg.sender when strictSender=true).
     * @param contentId  Knowledge content id.
     * @param score      Integer score (0–100), as signed.
     * @param kalAmount  KAL reward in wei (18-dec), as signed. 100% to the learner.
     * @param expiry     Unix timestamp after which the signature is invalid.
     * @param nonce      Unique bytes32 nonce preventing replay.
     * @param tokenUri   Base64 data URI for this holder's ERC-1155 metadata.
     * @param signature  Oracle's EIP-712 signature over the attestation.
     */
    function verifyAndMint(
        address user,
        uint256 contentId,
        uint256 score,
        uint256 kalAmount,
        uint256 expiry,
        bytes32 nonce,
        string calldata tokenUri,
        bytes calldata signature
    ) external {
        if (strictSender && msg.sender != user) revert SenderMismatch();
        if (block.timestamp > expiry) revert SignatureExpired();
        if (usedNonces[nonce]) revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            ATTESTATION_TYPEHASH, user, contentId, score, kalAmount, expiry, nonce, keccak256(bytes(tokenUri))
        ));
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (recovered != oracleAddress) revert InvalidSignature();

        usedNonces[nonce] = true;

        uint256 tokenId = sbtTokenId(user, contentId);
        // Refresh this holder's metadata (supports retakes); mint only if not already held.
        IPoCW_SBT(sbtContract).setTokenURI(tokenId, tokenUri);
        if (IPoCW_SBT(sbtContract).balanceOf(user, tokenId) == 0) {
            IPoCW_SBT(sbtContract).mint(user, tokenId, 1);
        }

        // KAL reward — 100% to the learner, no treasury/split.
        // Paid at most once per (user, content): reattest can refresh the SBT
        // metadata but must not re-mint the reward.
        if (kalAmount > 0 && !kalClaimed[tokenId]) {
            kalClaimed[tokenId] = true;
            IKAL(kalToken).mint(user, kalAmount);
        }

        emit Attested(user, contentId, tokenId, score, kalAmount, nonce);
    }
}
