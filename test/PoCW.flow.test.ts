import { expect } from "chai";
import { ethers } from "hardhat";

const ATT_TYPES = {
  Attestation: [
    { name: "user", type: "address" },
    { name: "contentId", type: "uint256" },
    { name: "score", type: "uint256" },
    { name: "kalAmount", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "tokenUriHash", type: "bytes32" },
  ],
};

async function signAttestation(
  oracle: any,
  verifyingContract: string,
  chainId: number,
  att: { user: string; contentId: number; score: number; kalAmount: bigint; expiry: number; nonce: string; tokenUri: string }
): Promise<string> {
  const domain = { name: "PoCW", version: "1", chainId, verifyingContract };
  return oracle.signTypedData(domain, ATT_TYPES, {
    user: att.user, contentId: att.contentId, score: att.score, kalAmount: att.kalAmount,
    expiry: att.expiry, nonce: att.nonce, tokenUriHash: ethers.keccak256(ethers.toUtf8Bytes(att.tokenUri)),
  });
}

describe("PoCW full flow", function () {
  async function deployContracts(strictSender = false) {
    const [deployer, oracle, user] = await ethers.getSigners();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    const kal = await (await ethers.getContractFactory("KAL")).deploy();
    await kal.waitForDeployment();
    const sbt = await (await ethers.getContractFactory("PoCW_SBT")).deploy();
    await sbt.waitForDeployment();
    const controller = await (await ethers.getContractFactory("PoCW_Controller")).deploy(
      oracle.address, await sbt.getAddress(), await kal.getAddress(), strictSender
    );
    await controller.waitForDeployment();
    const controllerAddr = await controller.getAddress();
    await sbt.transferOwnership(controllerAddr);
    await kal.transferOwnership(controllerAddr);
    return { deployer, oracle, user, kal, sbt, controller, controllerAddr, chainId };
  }

  const future = () => Math.floor(Date.now() / 1000) + 3600;

  it("verifies oracle attestation and mints SBT (per-holder id) + KAL", async () => {
    const { oracle, user, kal, sbt, controller, controllerAddr, chainId } = await deployContracts();
    const contentId = 1, score = 85;
    const kalAmount = ethers.parseEther("50");
    const expiry = future();
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const tokenUri = "data:application/json;base64,eyJmbG93IjoidGVzdCJ9";

    const sig = await signAttestation(oracle, controllerAddr, chainId, { user: user.address, contentId, score, kalAmount, expiry, nonce, tokenUri });
    await controller.verifyAndMint(user.address, contentId, score, kalAmount, expiry, nonce, tokenUri, sig);

    const tokenId = await controller.sbtTokenId(user.address, contentId);
    expect(await sbt.balanceOf(user.address, tokenId)).to.equal(1n);
    expect(await sbt.uri(tokenId)).to.equal(tokenUri);
    expect(await kal.balanceOf(user.address)).to.equal(kalAmount);
  });

  it("rejects invalid oracle signature", async () => {
    const [, , , attacker] = await ethers.getSigners();
    const { user, controller, controllerAddr, chainId } = await deployContracts();
    const expiry = future();
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const tokenUri = "data:application/json;base64,eyJmbG93IjoiYmFkIn0=";
    const bad = await signAttestation(attacker, controllerAddr, chainId, { user: user.address, contentId: 1, score: 90, kalAmount: 0n, expiry, nonce, tokenUri });
    await expect(
      controller.verifyAndMint(user.address, 1, 90, 0n, expiry, nonce, tokenUri, bad)
    ).to.be.revertedWithCustomError(controller, "InvalidSignature");
  });

  it("rejects transfer of soulbound token", async () => {
    const { oracle, user, sbt, controller, controllerAddr, chainId } = await deployContracts();
    const [, , , recipient] = await ethers.getSigners();
    const expiry = future();
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const tokenUri = "data:application/json;base64,eyJmbG93Ijoic291bCJ9";
    const sig = await signAttestation(oracle, controllerAddr, chainId, { user: user.address, contentId: 2, score: 80, kalAmount: 0n, expiry, nonce, tokenUri });
    await controller.verifyAndMint(user.address, 2, 80, 0n, expiry, nonce, tokenUri, sig);
    const tokenId = await controller.sbtTokenId(user.address, 2);
    await expect(
      sbt.connect(user).safeTransferFrom(user.address, recipient.address, tokenId, 1, "0x")
    ).to.be.revertedWith("Soulbound: transfers disabled");
  });
});
