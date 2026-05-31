/**
 * KAL On-Chain Minter
 *
 * Called by the oracle after a passing session to mint KAL tokens.
 * Uses the same ORACLE_PRIVATE_KEY as the attestation signer.
 * Requires RPC_URL and KAL_ADDRESS env vars — silently skips if unset.
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

const { ORACLE_PRIVATE_KEY, RPC_URL, KAL_ADDRESS } = process.env;

const KAL_ABI = ["function mint(address to, uint256 amount) external"];

let _contract: ethers.Contract | null = null;

function getKALContract(): ethers.Contract | null {
  if (!ORACLE_PRIVATE_KEY || !RPC_URL || !KAL_ADDRESS) return null;
  if (_contract) return _contract;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
  _contract = new ethers.Contract(KAL_ADDRESS, KAL_ABI, wallet);
  return _contract;
}

/**
 * Mint `kalAmount` KAL (in token units, e.g. 73.5) to `to`.
 * Returns the tx hash on success, null if KAL minting is not configured.
 */
export async function mintKAL(to: string, kalAmount: number): Promise<string | null> {
  const kal = getKALContract();
  if (!kal || kalAmount <= 0) return null;
  const amountWei = ethers.parseEther(kalAmount.toFixed(18));
  const tx = await kal.mint(to, amountWei);
  await tx.wait();
  return tx.hash as string;
}

export function isKALConfigured(): boolean {
  return !!(ORACLE_PRIVATE_KEY && RPC_URL && KAL_ADDRESS);
}
