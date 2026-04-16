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

describe("PoCW Protocol", function () {
  async function deploy(strictSender = false) {
    const [deployer, oracle, user] = await ethers.getSigners();

    const PoCW_SBT = await ethers.getContractFactory("PoCW_SBT");
    const sbt = await PoCW_SBT.connect(deployer).deploy();
    await sbt.waitForDeployment();

    const PoCW_Controller = await ethers.getContractFactory("PoCW_Controller");
    const controller = await PoCW_Controller.connect(deployer).deploy(
      oracle.address,
      await sbt.getAddress(),
      strictSender
    );
    await controller.waitForDeployment();

    await (await sbt.transferOwnership(await controller.getAddress())).wait();
    return { deployer, oracle, user, sbt, controller };
  }

  it("verifies signature and mints soulbound token with tokenURI", async function () {
    const { oracle, user, sbt, controller } = await deploy();

    const contentId = 1;
    const score = 80;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const tokenUri = "data:application/json;base64,eyJ0ZXN0IjoidHJ1ZSJ9";

    const signature = await buildSignature(oracle, user.address, contentId, score, expiry, nonce, tokenUri);

    await controller.verifyAndMint(user.address, contentId, score, expiry, nonce, tokenUri, signature);

    expect(await sbt.balanceOf(user.address, contentId)).to.equal(1n);
    expect(await sbt.uri(contentId)).to.equal(tokenUri);
  });

  it("rejects expired signature", async function () {
    const { oracle, user, controller } = await deploy();

    const contentId = 2;
    const score = 75;
    const expiry = Math.floor(Date.now() / 1000) - 1; // already expired
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const tokenUri = "data:application/json;base64,eyJ0ZXN0IjoiZXhwaXJlZCJ9";

    const signature = await buildSignature(oracle, user.address, contentId, score, expiry, nonce, tokenUri);

    await expect(
      controller.verifyAndMint(user.address, contentId, score, expiry, nonce, tokenUri, signature)
    ).to.be.revertedWithCustomError(controller, "SignatureExpired");
  });

  it("rejects replayed nonce", async function () {
    const { oracle, user, controller } = await deploy();

    const contentId = 3;
    const score = 90;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const tokenUri = "data:application/json;base64,eyJ0ZXN0IjoicmVwbGF5In0=";

    const signature = await buildSignature(oracle, user.address, contentId, score, expiry, nonce, tokenUri);

    await controller.verifyAndMint(user.address, contentId, score, expiry, nonce, tokenUri, signature);

    await expect(
      controller.verifyAndMint(user.address, contentId, score, expiry, nonce, tokenUri, signature)
    ).to.be.revertedWithCustomError(controller, "NonceAlreadyUsed");
  });

  it("rejects invalid oracle signature", async function () {
    const [, , , attacker] = await ethers.getSigners();
    const { user, controller } = await deploy();

    const contentId = 4;
    const score = 88;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const tokenUri = "data:application/json;base64,eyJ0ZXN0IjoiYmFkc2lnIn0=";

    // attacker signs instead of oracle
    const badSignature = await buildSignature(attacker, user.address, contentId, score, expiry, nonce, tokenUri);

    await expect(
      controller.verifyAndMint(user.address, contentId, score, expiry, nonce, tokenUri, badSignature)
    ).to.be.revertedWithCustomError(controller, "InvalidSignature");
  });

  it("rejects sender mismatch when strictSender=true", async function () {
    const [, oracle, user, thirdParty] = await ethers.getSigners();
    const { controller } = await deploy(true); // strictSender enabled

    const contentId = 5;
    const score = 70;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const tokenUri = "data:application/json;base64,eyJ0ZXN0Ijoic3RyaWN0In0=";

    const signature = await buildSignature(oracle, user.address, contentId, score, expiry, nonce, tokenUri);

    // thirdParty submits on behalf of user — should revert
    await expect(
      controller.connect(thirdParty).verifyAndMint(user.address, contentId, score, expiry, nonce, tokenUri, signature)
    ).to.be.revertedWithCustomError(controller, "SenderMismatch");
  });
});
