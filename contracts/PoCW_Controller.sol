// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IPoCW_SBT {
    function mint(address to, uint256 id, uint256 amount) external;
}

/**
 * @title PoCW_Controller
 * @notice Verifies oracle signatures and mints soulbound tokens.
 */
contract PoCW_Controller {
    using ECDSA for bytes32;

    address public immutable oracleAddress;
    address public immutable sbtContract;

    error InvalidSignature();

    constructor(address _oracleAddress, address _sbtContract) {
        require(_oracleAddress != address(0), "Invalid oracle");
        require(_sbtContract != address(0), "Invalid SBT");
        oracleAddress = _oracleAddress;
        sbtContract = _sbtContract;
    }

    /**
     * @dev Verify oracle signature and mint an SBT to the user.
     */
    function verifyAndMint(
        address user,
        uint256 contentId,
        uint256 score,
        bytes memory signature
    ) external {
        bytes32 messageHash = keccak256(abi.encodePacked(user, contentId, score));
        bytes32 signedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        address recovered = ECDSA.recover(signedHash, signature);

        if (recovered != oracleAddress) {
            revert InvalidSignature();
        }

        IPoCW_SBT(sbtContract).mint(user, contentId, 1);
    }
}

