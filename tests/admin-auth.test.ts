import { expect } from "chai";
import { ethers } from "ethers";
import { verifyAdminAction, __clearNonces, AdminAuthPayload } from "../src/services/admin-auth";

const TYPES = {
  AdminAction: [
    { name: "action", type: "string" },
    { name: "target", type: "string" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const CHAIN_ID = 84532;

describe("Admin Auth (EIP-712)", () => {
  let admin: ethers.HDNodeWallet;
  let outsider: ethers.HDNodeWallet;
  let prevAdmin: string | undefined;
  let prevChain: string | undefined;

  function sign(
    wallet: ethers.HDNodeWallet,
    action: string,
    target: string,
    expiry: number,
    nonce: string
  ): Promise<string> {
    const domain = { name: "PoCW-Admin", version: "1", chainId: CHAIN_ID };
    return wallet.signTypedData(domain, TYPES, { action, target, expiry: BigInt(expiry), nonce });
  }

  const payload = (
    action: string,
    target: string,
    expiry: number,
    nonce: string,
    signature: string
  ): AdminAuthPayload => ({ action, target, expiry, nonce, signature });

  const future = () => Math.floor(Date.now() / 1000) + 300;
  const nonce = () => ethers.hexlify(ethers.randomBytes(32));

  beforeEach(() => {
    admin = ethers.Wallet.createRandom();
    outsider = ethers.Wallet.createRandom();
    prevAdmin = process.env.ADMIN_ADDRESS;
    prevChain = process.env.CHAIN_ID;
    process.env.ADMIN_ADDRESS = admin.address;
    process.env.CHAIN_ID = String(CHAIN_ID);
    __clearNonces();
  });

  afterEach(() => {
    if (prevAdmin === undefined) delete process.env.ADMIN_ADDRESS;
    else process.env.ADMIN_ADDRESS = prevAdmin;
    if (prevChain === undefined) delete process.env.CHAIN_ID;
    else process.env.CHAIN_ID = prevChain;
  });

  it("accepts a valid signature from the admin wallet", async () => {
    const exp = future(), n = nonce();
    const sig = await sign(admin, "delete", "course-1", exp, n);
    const res = verifyAdminAction(payload("delete", "course-1", exp, n, sig), "delete", "course-1");
    expect(res.ok).to.be.true;
  });

  it("rejects a signature from a non-admin wallet", async () => {
    const exp = future(), n = nonce();
    const sig = await sign(outsider, "delete", "course-1", exp, n);
    const res = verifyAdminAction(payload("delete", "course-1", exp, n, sig), "delete", "course-1");
    expect(res.ok).to.be.false;
    expect(res.error).to.match(/admin wallet/i);
  });

  it("rejects an expired authorization", async () => {
    const exp = Math.floor(Date.now() / 1000) - 10, n = nonce();
    const sig = await sign(admin, "delete", "course-1", exp, n);
    const res = verifyAdminAction(payload("delete", "course-1", exp, n, sig), "delete", "course-1");
    expect(res.ok).to.be.false;
    expect(res.error).to.match(/expired/i);
  });

  it("rejects a replayed nonce (single-use)", async () => {
    const exp = future(), n = nonce();
    const sig = await sign(admin, "delete", "course-1", exp, n);
    const first = verifyAdminAction(payload("delete", "course-1", exp, n, sig), "delete", "course-1");
    expect(first.ok).to.be.true;
    const second = verifyAdminAction(payload("delete", "course-1", exp, n, sig), "delete", "course-1");
    expect(second.ok).to.be.false;
    expect(second.error).to.match(/replay/i);
  });

  it("rejects repurposing a delete signature as a wipe (action/target binding)", async () => {
    const exp = future(), n = nonce();
    const sig = await sign(admin, "delete", "course-1", exp, n);
    const res = verifyAdminAction(payload("delete", "course-1", exp, n, sig), "wipe", "*");
    expect(res.ok).to.be.false;
  });

  it("is open (dev mode) when ADMIN_ADDRESS is unset", () => {
    delete process.env.ADMIN_ADDRESS;
    const res = verifyAdminAction(undefined, "delete", "course-1");
    expect(res.ok).to.be.true;
  });
});
