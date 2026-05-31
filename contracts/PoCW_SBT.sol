// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

/**
 * @title PoCW_SBT
 * @notice Soulbound ERC1155. Only the contract owner (controller) can mint or set URIs.
 *         All transfers are blocked. Each token id carries a metadata URI set at mint time.
 */
contract PoCW_SBT is ERC1155URIStorage, Ownable {

    // ── Collection identity (read by Etherscan, BaseScan, OpenSea) ───────────
    string public constant name   = "Proof of Cognitive Work";
    string public constant symbol = "PoCW";

    constructor() ERC1155("") Ownable(msg.sender) {}

    // ── Collection-level metadata (OpenSea / BaseScan collection page) ───────
    /**
     * @dev Returns the collection metadata URI.
     *      Explorers and marketplaces call this to display the collection name,
     *      description, and logo image.
     */
    function contractURI() external pure returns (string memory) {
        bytes memory svgLogo = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">',
            '<rect width="200" height="200" rx="16" fill="#0c0c12"/>',
            '<text x="100" y="72" text-anchor="middle" font-family="monospace" font-size="13" fill="#7c3aed" font-weight="bold" letter-spacing="3">PoCW</text>',
            '<circle cx="100" cy="115" r="38" fill="none" stroke="#7c3aed" stroke-width="2.5"/>',
            '<text x="100" y="110" text-anchor="middle" font-family="monospace" font-size="11" fill="#94a3b8">Proof of</text>',
            '<text x="100" y="126" text-anchor="middle" font-family="monospace" font-size="11" fill="#94a3b8">Cognitive Work</text>',
            '<text x="100" y="172" text-anchor="middle" font-family="monospace" font-size="9" fill="#3b3b5c">soulbound credential</text>',
            '</svg>'
        );

        bytes memory json = abi.encodePacked(
            '{"name":"Proof of Cognitive Work",',
            '"description":"On-chain soulbound credentials issued by the PoCW oracle. Each token attests that a holder demonstrated knowledge of specific content, verified through adaptive IRT-based questioning.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(svgLogo), '",',
            '"external_link":"https://github.com/Cognitive-Layer-Labs/PoCW"}'
        );

        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(json)
        ));
    }

    // ── Token operations ─────────────────────────────────────────────────────

    /**
     * @dev Mint a soulbound token. Only callable by the owner (controller).
     */
    function mint(address to, uint256 id, uint256 amount) external onlyOwner {
        _mint(to, id, amount, "");
    }

    /**
     * @dev Set the metadata URI for a token id. Only callable by the owner (controller).
     *      Called by the controller before minting so uri() resolves immediately.
     */
    function setTokenURI(uint256 id, string calldata tokenUri) external onlyOwner {
        _setURI(id, tokenUri);
    }

    // ── Soulbound: block all transfers ────────────────────────────────────────

    function safeTransferFrom(address, address, uint256, uint256, bytes memory)
        public virtual override { revert("Soulbound: transfers disabled"); }

    function safeBatchTransferFrom(address, address, uint256[] memory, uint256[] memory, bytes memory)
        public virtual override { revert("Soulbound: transfers disabled"); }
}
