// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PoCW_SBT
 * @notice Soulbound ERC1155. Only the contract owner (controller) can mint.
 *         All transfers are blocked.
 */
contract PoCW_SBT is ERC1155, Ownable {
    constructor() ERC1155("") Ownable(msg.sender) {}

    /**
     * @dev Mint a soulbound token. Only callable by the owner (controller).
     */
    function mint(address to, uint256 id, uint256 amount) external onlyOwner {
        _mint(to, id, amount, "");
    }

    /// @dev Block single transfers to enforce soulbound semantics.
    function safeTransferFrom(
        address,
        address,
        uint256,
        uint256,
        bytes memory
    ) public virtual override {
        revert("Soulbound: transfers disabled");
    }

    /// @dev Block batch transfers to enforce soulbound semantics.
    function safeBatchTransferFrom(
        address,
        address,
        uint256[] memory,
        uint256[] memory,
        bytes memory
    ) public virtual override {
        revert("Soulbound: transfers disabled");
    }
}

