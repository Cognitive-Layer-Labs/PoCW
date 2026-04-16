import { expect } from "chai";
import { ethers } from "hardhat";

/** Build the oracle-signed payload matching PoCW_Controller's verifyAndMint hash. */
async function buildSignature(
  oracle: { signMessage: (b: Uint8Array) => Promise<string> },
  user: string,
  contentId: number,
  score: number,
  expiry: number,
  nonce: string,
  tokenUri: string
): Promise<string> {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const tokenUriHash = ethers.keccak256(ethers.toUtf8Bytes(tokenUri));
  const encoded = abiCoder.encode(
    ["address", "uint256", "uint256", "bytes32", "uint256", "bytes32"],
    [user, contentId, score, nonce, expiry, tokenUriHash]
  );
  const messageHash = ethers.keccak256(encoded);
  return oracle.signMessage(ethers.getBytes(messageHash));
}

describe("PoCW full flow", function () {
  async function deployContracts(strictSender = false) {
    const [deployer, oracle, user] = await ethers.getSigners();

    const SBT = await ethers.getContractFactory("PoCW_SBT");
    const sbt = await SBT.deploy();
    await sbt.waitForDeployment();

    const Controller = await ethers.getContractFactory("PoCW_Controller");
    const controller = await Controller.deploy(
      oracle.address,
      await sbt.getAddress(),
      strictSender
    );
    await controller.waitForDeployment();

    await sbt.transferOwnership(await controller.getAddress());
    return { deployer, oracle, user, sbt, controller };
  }

  it("verifies oracle signature and mints SBT with tokenURI", async () => {
    const { oracle, user, sbt, controller } = await deployContracts();

    const contentId = 1;
    const score = 85;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const tokenUri = "data:application/json;base64,eyJmbG93IjoidGVzdCJ9";

    const signature = await buildSignature(oracle, user.address, contentId, score, expiry, nonce, tokenUri);

    await controller.verifyAndMint(user.address, contentId, score, expiry, nonce, tokenUri, signature);

    expect(await sbt.balanceOf(user.address, contentId)).to.equal(1);
    expect(await sbt.uri(contentId)).to.equal(tokenUri);
  });

  it("rejects invalid oracle signature", async () => {
    const [, , , attacker] = await ethers.getSigners();
    const { user, controller } = await deployContracts();

    const contentId = 1;
    const score = 90;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const tokenUri = "data:application/json;base64,eyJmbG93IjoiYmFkIn0=";

    const badSignature = await buildSignature(attacker, user.address, contentId, score, expiry, nonce, tokenUri);

    await expect(
      controller.verifyAndMint(user.address, contentId, score, expiry, nonce, tokenUri, badSignature)
    ).to.be.revertedWithCustomError(controller, "InvalidSignature");
  });

  it("rejects transfer of soulbound token", async () => {
    const { oracle, user, sbt, controller } = await deployContracts();
    const [, , , recipient] = await ethers.getSigners();

    const contentId = 2;
    const score = 80;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const tokenUri = "data:application/json;base64,eyJmbG93Ijoic291bCJ9";

    const signature = await buildSignature(oracle, user.address, contentId, score, expiry, nonce, tokenUri);
    await controller.verifyAndMint(user.address, contentId, score, expiry, nonce, tokenUri, signature);

    await expect(
      sbt.connect(user).safeTransferFrom(user.address, recipient.address, contentId, 1, "0x")
    ).to.be.revertedWith("Soulbound: transfers disabled");
  });
});
