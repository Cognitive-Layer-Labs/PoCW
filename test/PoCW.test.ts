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

/** EIP-712 sign an attestation for a given controller (verifyingContract) + chainId. */
async function signAttestation(
  oracle: any,
  verifyingContract: string,
  chainId: number,
  att: { user: string; contentId: number; score: number; kalAmount: bigint; expiry: number; nonce: string; tokenUri: string }
): Promise<string> {
  const domain = { name: "PoCW", version: "1", chainId, verifyingContract };
  const value = {
    user: att.user,
    contentId: att.contentId,
    score: att.score,
    kalAmount: att.kalAmount,
    expiry: att.expiry,
    nonce: att.nonce,
    tokenUriHash: ethers.keccak256(ethers.toUtf8Bytes(att.tokenUri)),
  };
  return oracle.signTypedData(domain, ATT_TYPES, value);
}

describe("PoCW Protocol", function () {
  async function deploy(strictSender = false) {
    const [deployer, oracle, user] = await ethers.getSigners();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    const KAL = await ethers.getContractFactory("KAL");
    const kal = await KAL.connect(deployer).deploy();
    await kal.waitForDeployment();

    const PoCW_SBT = await ethers.getContractFactory("PoCW_SBT");
    const sbt = await PoCW_SBT.connect(deployer).deploy();
    await sbt.waitForDeployment();

    const PoCW_Controller = await ethers.getContractFactory("PoCW_Controller");
    const controller = await PoCW_Controller.connect(deployer).deploy(
      oracle.address,
      await sbt.getAddress(),
      await kal.getAddress(),
      strictSender
    );
    await controller.waitForDeployment();

    const controllerAddr = await controller.getAddress();
    await (await sbt.transferOwnership(controllerAddr)).wait();
    await (await kal.transferOwnership(controllerAddr)).wait();
    return { deployer, oracle, user, kal, sbt, controller, controllerAddr, chainId };
  }

  const future = () => Math.floor(Date.now() / 1000) + 3600;
  const URI = "data:application/json;base64,eyJ0ZXN0IjoidHJ1ZSJ9";

  it("verifies EIP-712 attestation, mints the per-holder SBT + KAL atomically", async function () {
    const { oracle, user, kal, sbt, controller, controllerAddr, chainId } = await deploy();
    const contentId = 1, score = 80;
    const kalAmount = ethers.parseEther("73.5");
    const expiry = future();
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    const sig = await signAttestation(oracle, controllerAddr, chainId, { user: user.address, contentId, score, kalAmount, expiry, nonce, tokenUri: URI });
    await controller.verifyAndMint(user.address, contentId, score, kalAmount, expiry, nonce, URI, sig);

    const tokenId = await controller.sbtTokenId(user.address, contentId);
    expect(await sbt.balanceOf(user.address, tokenId)).to.equal(1n);
    expect(await sbt.uri(tokenId)).to.equal(URI);
    expect(await kal.balanceOf(user.address)).to.equal(kalAmount); // 100% to the learner
    // contentId is NOT the token id (per-holder isolation)
    expect(await sbt.balanceOf(user.address, contentId)).to.equal(0n);
  });

  it("isolates metadata per holder — a later minter cannot clobber an earlier holder", async function () {
    const { oracle, user, sbt, controller, controllerAddr, chainId } = await deploy();
    const [, , , userB] = await ethers.getSigners();
    const contentId = 7;
    const uriA = "data:application/json;base64,QQ=="; // "A"
    const uriB = "data:application/json;base64,Qg=="; // "B"

    for (const [u, uri, score] of [[user, uriA, 95], [userB, uriB, 40]] as const) {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const sig = await signAttestation(oracle, controllerAddr, chainId, { user: u.address, contentId, score, kalAmount: 0n, expiry: future(), nonce, tokenUri: uri });
      await controller.verifyAndMint(u.address, contentId, score, 0n, future(), nonce, uri, sig);
    }
    const idA = await controller.sbtTokenId(user.address, contentId);
    const idB = await controller.sbtTokenId(userB.address, contentId);
    expect(idA).to.not.equal(idB);
    expect(await sbt.uri(idA)).to.equal(uriA); // A's metadata intact after B mints
    expect(await sbt.uri(idB)).to.equal(uriB);
  });

  it("blocks soulbound transfers", async function () {
    const { oracle, user, sbt, controller, controllerAddr, chainId } = await deploy();
    const [, , , other] = await ethers.getSigners();
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const sig = await signAttestation(oracle, controllerAddr, chainId, { user: user.address, contentId: 1, score: 80, kalAmount: 0n, expiry: future(), nonce, tokenUri: URI });
    await controller.verifyAndMint(user.address, 1, 80, 0n, future(), nonce, URI, sig);
    const tokenId = await controller.sbtTokenId(user.address, 1);
    await expect(
      sbt.connect(user).safeTransferFrom(user.address, other.address, tokenId, 1, "0x")
    ).to.be.revertedWith("Soulbound: transfers disabled");
  });

  it("rejects a signature bound to a different controller (domain separation / cross-deploy replay)", async function () {
    const { oracle, user, controller, chainId } = await deploy();
    const contentId = 9, score = 88, expiry = future();
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    // Sign for a DIFFERENT verifyingContract address — must not verify here.
    const wrongContract = ethers.Wallet.createRandom().address;
    const sig = await signAttestation(oracle, wrongContract, chainId, { user: user.address, contentId, score, kalAmount: 0n, expiry, nonce, tokenUri: URI });
    await expect(
      controller.verifyAndMint(user.address, contentId, score, 0n, expiry, nonce, URI, sig)
    ).to.be.revertedWithCustomError(controller, "InvalidSignature");
  });

  it("rejects expired signature", async function () {
    const { oracle, user, controller, controllerAddr, chainId } = await deploy();
    const expiry = Math.floor(Date.now() / 1000) - 1;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const sig = await signAttestation(oracle, controllerAddr, chainId, { user: user.address, contentId: 2, score: 75, kalAmount: 0n, expiry, nonce, tokenUri: URI });
    await expect(
      controller.verifyAndMint(user.address, 2, 75, 0n, expiry, nonce, URI, sig)
    ).to.be.revertedWithCustomError(controller, "SignatureExpired");
  });

  it("rejects replayed nonce", async function () {
    const { oracle, user, controller, controllerAddr, chainId } = await deploy();
    const expiry = future();
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const sig = await signAttestation(oracle, controllerAddr, chainId, { user: user.address, contentId: 3, score: 90, kalAmount: 0n, expiry, nonce, tokenUri: URI });
    await controller.verifyAndMint(user.address, 3, 90, 0n, expiry, nonce, URI, sig);
    await expect(
      controller.verifyAndMint(user.address, 3, 90, 0n, expiry, nonce, URI, sig)
    ).to.be.revertedWithCustomError(controller, "NonceAlreadyUsed");
  });

  it("rejects invalid oracle signature", async function () {
    const [, , , attacker] = await ethers.getSigners();
    const { user, controller, controllerAddr, chainId } = await deploy();
    const expiry = future();
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const sig = await signAttestation(attacker, controllerAddr, chainId, { user: user.address, contentId: 4, score: 88, kalAmount: 0n, expiry, nonce, tokenUri: URI });
    await expect(
      controller.verifyAndMint(user.address, 4, 88, 0n, expiry, nonce, URI, sig)
    ).to.be.revertedWithCustomError(controller, "InvalidSignature");
  });

  it("rejects sender mismatch when strictSender=true", async function () {
    const { oracle, user, controller, controllerAddr, chainId } = await deploy(true);
    const [, , , thirdParty] = await ethers.getSigners();
    const expiry = future();
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const sig = await signAttestation(oracle, controllerAddr, chainId, { user: user.address, contentId: 5, score: 70, kalAmount: 0n, expiry, nonce, tokenUri: URI });
    await expect(
      controller.connect(thirdParty).verifyAndMint(user.address, 5, 70, 0n, expiry, nonce, URI, sig)
    ).to.be.revertedWithCustomError(controller, "SenderMismatch");
  });
});
