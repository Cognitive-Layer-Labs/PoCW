// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IPoCW_SBT {
    function mint(address to, uint256 id, uint256 amount) external;
    function setTokenURI(uint256 id, string calldata uri) external;
}

/**
 * @title PoCW_Controller
 * @notice Verifies oracle signatures and mints soulbound tokens.
 *
 * Signed payload (eth_sign of keccak256):
 *   abi.encode(user, contentId, score, nonce, expiry, keccak256(bytes(tokenUri)))
 *
 * Security properties:
 *   - Replay protection: nonces are marked used on-chain.
 *   - Expiry: signatures are valid for a finite window (oracle sets 24 h TTL).
 *   - Sender check (strictSender=true): only the attested user can submit the tx.
 */
contract PoCW_Controller {
    using ECDSA for bytes32;

    address public immutable oracleAddress;
    address public immutable sbtContract;
    bool public immutable strictSender;

    mapping(bytes32 => bool) public usedNonces;

    error InvalidSignature();
    error SignatureExpired();
    error NonceAlreadyUsed();
    error SenderMismatch();

    constructor(address _oracleAddress, address _sbtContract, bool _strictSender) {
        require(_oracleAddress != address(0), "Invalid oracle");
        require(_sbtContract != address(0), "Invalid SBT");
        oracleAddress = _oracleAddress;
        sbtContract = _sbtContract;
        strictSender = _strictSender;
    }

    /**
     * @notice Verify oracle signature and mint an SBT to the user.
     * @param user         Address the SBT is minted to (must match msg.sender when strictSender=true).
     * @param contentId    Identifies the knowledge content; used as ERC-1155 token id.
     * @param score        Integer score (0–100) as included in the oracle signature.
     * @param expiry       Unix timestamp after which the signature is invalid.
     * @param nonce        Unique bytes32 nonce preventing replay.
     * @param tokenUri     Base64 data URI for ERC-1155 metadata (encoded by oracle before signing).
     * @param signature    Oracle's eth_sign signature over the above fields.
     */
    function verifyAndMint(
        address user,
        uint256 contentId,
        uint256 score,
        uint256 expiry,
        bytes32 nonce,
        string calldata tokenUri,
        bytes calldata signature
    ) external {
        if (strictSender && msg.sender != user) revert SenderMismatch();
        if (block.timestamp > expiry) revert SignatureExpired();
        if (usedNonces[nonce]) revert NonceAlreadyUsed();

        bytes32 messageHash = keccak256(
            abi.encode(user, contentId, score, nonce, expiry, keccak256(bytes(tokenUri)))
        );
        bytes32 signedHash = MessageHashUtils.toEthSignedMessageHash(messageHash);
        address recovered = ECDSA.recover(signedHash, signature);

        if (recovered != oracleAddress) revert InvalidSignature();

        usedNonces[nonce] = true;
        IPoCW_SBT(sbtContract).setTokenURI(contentId, tokenUri);
        IPoCW_SBT(sbtContract).mint(user, contentId, 1);
    }
}
