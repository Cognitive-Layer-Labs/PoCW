import { expect } from "chai";
import { ethers } from "hardhat";

describe("PoCW Protocol", function () {
  it("verifies signature and mints soulbound token", async function () {
    const [deployer, oracle, user] = await ethers.getSigners();

    const PoCW_SBT = await ethers.getContractFactory("PoCW_SBT");
    const sbt = await PoCW_SBT.connect(deployer).deploy();
    await sbt.waitForDeployment();

    const PoCW_Controller = await ethers.getContractFactory("PoCW_Controller");
    const controller = await PoCW_Controller.connect(deployer).deploy(
      oracle.address,
      await sbt.getAddress()
    );
    await controller.waitForDeployment();

    await (await sbt.transferOwnership(await controller.getAddress())).wait();

    const contentId = 1;
    const score = 80;
    const hash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256"],
      [user.address, contentId, score]
    );
    const signature = await oracle.signMessage(ethers.getBytes(hash));

    await controller.verifyAndMint(user.address, contentId, score, signature);

    const balance = await sbt.balanceOf(user.address, contentId);
    expect(balance).to.equal(1n);
  });
});

