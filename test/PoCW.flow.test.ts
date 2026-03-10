import { expect } from "chai";
import { ethers } from "hardhat";

describe("PoCW full flow", function () {
  it("verifies oracle signature and mints SBT", async () => {
    const [deployer, oracle, user] = await ethers.getSigners();

    /* deploy SBT */
    const SBT = await ethers.getContractFactory("PoCW_SBT");
    const sbt = await SBT.deploy();
    await sbt.waitForDeployment();

    /* deploy controller */
    const Controller = await ethers.getContractFactory("PoCW_Controller");
    const controller = await Controller.deploy(
      oracle.address,
      await sbt.getAddress()
    );
    await controller.waitForDeployment();

    /* transfer SBT ownership to controller */
    await sbt.transferOwnership(await controller.getAddress());

    /* off-chain simulation */
    const contentId = 1;
    const score = 85;

    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256"],
      [user.address, contentId, score]
    );

    const signedMessage = await oracle.signMessage(
      ethers.getBytes(messageHash)
    );

    /* call verifyAndMint */
    await controller.verifyAndMint(
      user.address,
      contentId,
      score,
      signedMessage
    );

    /* assert SBT minted */
    const balance = await sbt.balanceOf(user.address, contentId);
    expect(balance).to.equal(1);
  });

  it("rejects invalid oracle signature", async () => {
    const [deployer, oracle, attacker, user] = await ethers.getSigners();

    const SBT = await ethers.getContractFactory("PoCW_SBT");
    const sbt = await SBT.deploy();
    await sbt.waitForDeployment();

    const Controller = await ethers.getContractFactory("PoCW_Controller");
    const controller = await Controller.deploy(
      oracle.address,
      await sbt.getAddress()
    );
    await controller.waitForDeployment();

    await sbt.transferOwnership(await controller.getAddress());

    const contentId = 1;
    const score = 90;

    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256"],
      [user.address, contentId, score]
    );

    /* attacker signs instead of oracle */
    const badSignature = await attacker.signMessage(
      ethers.getBytes(messageHash)
    );

    await expect(
      controller.verifyAndMint(
        user.address,
        contentId,
        score,
        badSignature
      )
    ).to.be.revertedWithCustomError(controller, "InvalidSignature");
  });
});
