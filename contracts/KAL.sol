// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title KAL — Knowledge as Liquidity
 * @notice ERC-20 token minted by the PoCW oracle when a learner earns an SBT.
 *         Only the oracle (owner) can mint. Standard ERC-20 transfers apply.
 */
contract KAL is ERC20, Ownable {
    constructor() ERC20("Knowledge as Liquidity", "KAL") Ownable(msg.sender) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
