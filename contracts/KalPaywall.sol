// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IKAL {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/**
 * @title KalPaywall
 * @notice Gates access to paid KaL courses. Oracle issues a signed price quote;
 *         the buyer presents it here, KAL is pulled into the treasury, and
 *         access is recorded on-chain.
 *
 * EIP-712 typed data:
 *   domain = ("KalPaywall", "1", chainId, this)
 *   struct = Quote(address buyer,uint256 contentId,uint256 price,uint256 expiry,bytes32 nonce)
 *
 * Security properties:
 *   - Domain separation: chainId + this contract bound into the signature (no cross-chain replay).
 *   - Replay protection: nonces are burned on use.
 *   - Expiry: quotes are valid for a short oracle-set window (e.g. 10 min).
 *   - Price source: the oracle backend — callers cannot forge a lower price.
 *   - Buyer match: only the attested buyer can present the quote.
 */
contract KalPaywall is EIP712 {
    using ECDSA for bytes32;

    address public immutable oracle;
    address public immutable kal;
    address public immutable treasury;

    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "Quote(address buyer,uint256 contentId,uint256 price,uint256 expiry,bytes32 nonce)"
    );

    mapping(bytes32 => bool) public usedNonces;
    /// @notice hasPaid[buyer][contentId] — set after a successful purchase
    mapping(address => mapping(uint256 => bool)) public hasPaid;

    error InvalidSignature();
    error SignatureExpired();
    error NonceAlreadyUsed();
    error BuyerMismatch();
    error InsufficientAllowance();
    error TransferFailed();

    event Purchased(address indexed buyer, uint256 indexed contentId, uint256 price);

    constructor(address _kal, address _oracle, address _treasury) EIP712("KalPaywall", "1") {
        require(_kal != address(0), "Invalid KAL");
        require(_oracle != address(0), "Invalid oracle");
        require(_treasury != address(0), "Invalid treasury");
        kal = _kal;
        oracle = _oracle;
        treasury = _treasury;
    }

    /**
     * @notice Purchase access to a paid course.
     * @param contentId  The integer content id of the course.
     * @param price      KAL amount (18-decimal) as quoted and signed by the oracle.
     * @param expiry     Unix timestamp after which the quote is invalid.
     * @param nonce      Unique bytes32 nonce preventing replay.
     * @param signature  Oracle's eth_sign over (buyer, contentId, price, nonce, expiry).
     */
    function purchase(
        uint256 contentId,
        uint256 price,
        uint256 expiry,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        address buyer = msg.sender;

        if (block.timestamp > expiry) revert SignatureExpired();
        if (usedNonces[nonce]) revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(QUOTE_TYPEHASH, buyer, contentId, price, expiry, nonce));
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (recovered != oracle) revert InvalidSignature();

        // Check allowance before attempting transfer
        if (IKAL(kal).allowance(buyer, address(this)) < price) revert InsufficientAllowance();

        usedNonces[nonce] = true;
        hasPaid[buyer][contentId] = true;

        bool ok = IKAL(kal).transferFrom(buyer, treasury, price);
        if (!ok) revert TransferFailed();

        emit Purchased(buyer, contentId, price);
    }
}
