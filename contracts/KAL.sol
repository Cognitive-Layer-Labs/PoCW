// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title KAL — Knowledge as Liquidity
 * @notice ERC-20 reward token. The owner is the PoCW_Controller, which mints KAL atomically
 *         inside verifyAndMint() when a learner earns an SBT — so KAL can only be created through
 *         a signed, expiring, nonce-protected oracle attestation. 100% goes to the learner
 *         (no treasury cut / split). Standard ERC-20 transfers apply.
 */
contract KAL is ERC20, Ownable {
    constructor() ERC20("Knowledge as Liquidity", "KAL") Ownable(msg.sender) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
