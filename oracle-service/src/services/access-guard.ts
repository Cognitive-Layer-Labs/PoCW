/**
 * Access Guard — on-chain enforcement for the KaL access tiers.
 *
 * Paid courses: KalPaywall.hasPaid(buyer, contentId)
 * Unlocked courses: PoCW_SBT.balanceOf(user, prereqContentId) > 0 for any prereq
 *
 * Also signs oracle price-quotes for the frontend purchase flow:
 *   POST /api/access/quote → { contentId, price, expiry, nonce, signature }
 *   The user presents this to KalPaywall.purchase().
 *
 * Requires PAYWALL_ADDRESS, SBT_ADDRESS, ORACLE_PRIVATE_KEY, RPC_URL env vars.
 * Silently returns "allowed" when env vars are absent (dev with no chain).
 */

import { ethers, randomBytes } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";
import { paywallAddress as cfgPaywall, chainId as cfgChainId } from "./chain-config";

dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

/** Deterministic per-holder ERC-1155 token id (must match PoCW_Controller.sbtTokenId). */
function sbtTokenId(user: string, contentId: number): bigint {
  return ethers.toBigInt(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [user, BigInt(contentId)])
  ));
}

const QUOTE_TYPES = {
  Quote: [
    { name: "buyer", type: "address" },
    { name: "contentId", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const {
  ORACLE_PRIVATE_KEY,
  RPC_URL,
  PAYWALL_ADDRESS,
  SBT_ADDRESS,
} = process.env;

const PAYWALL_ABI = [
  "function hasPaid(address buyer, uint256 contentId) view returns (bool)",
];

const SBT_ABI = [
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

let _provider: ethers.JsonRpcProvider | null = null;
let _wallet: ethers.Wallet | null = null;
let _paywall: ethers.Contract | null = null;
let _sbt: ethers.Contract | null = null;

function getProvider(): ethers.JsonRpcProvider | null {
  if (!RPC_URL) return null;
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}

function getWallet(): ethers.Wallet | null {
  if (!ORACLE_PRIVATE_KEY) return null;
  const provider = getProvider();
  if (!provider) return null;
  if (!_wallet) _wallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
  return _wallet;
}

function getPaywall(): ethers.Contract | null {
  if (!PAYWALL_ADDRESS) return null;
  const provider = getProvider();
  if (!provider) return null;
  if (!_paywall) _paywall = new ethers.Contract(PAYWALL_ADDRESS, PAYWALL_ABI, provider);
  return _paywall;
}

function getSBT(): ethers.Contract | null {
  if (!SBT_ADDRESS) return null;
  const provider = getProvider();
  if (!provider) return null;
  if (!_sbt) _sbt = new ethers.Contract(SBT_ADDRESS, SBT_ABI, provider);
  return _sbt;
}

export function isAccessGuardConfigured(): boolean {
  return !!(ORACLE_PRIVATE_KEY && RPC_URL);
}

/**
 * Check whether a user has paid for a paid-tier course.
 * Returns true when the paywall is not configured (dev/no-chain).
 */
export async function checkHasPaid(
  buyer: string,
  contentId: number
): Promise<boolean> {
  const paywall = getPaywall();
  if (!paywall) return true; // not configured — dev/no-chain, assume open
  try {
    return await paywall.hasPaid(buyer, contentId) as boolean;
  } catch (err) {
    // Configured but the RPC failed — fail CLOSED (do not give away paid access).
    console.warn("[access-guard] hasPaid RPC error — failing closed:", err);
    return false;
  }
}

/**
 * Check whether a user holds ANY ONE of the listed prerequisite SBTs.
 * Returns true when the SBT contract is not configured (dev/no-chain).
 */
export async function checkHoldsPrereqSBT(
  user: string,
  prereqContentIds: number[]
): Promise<boolean> {
  const sbt = getSBT();
  if (!sbt || prereqContentIds.length === 0) return true;
  try {
    for (const prereqId of prereqContentIds) {
      // SBT ids are per-holder: tokenId = keccak(user, contentId).
      const tokenId = sbtTokenId(user, prereqId);
      const balance: bigint = await sbt.balanceOf(user, tokenId) as bigint;
      if (balance > 0n) return true;
    }
    return false;
  } catch (err) {
    // Configured but the RPC failed — fail CLOSED (keep the gated course locked).
    console.warn("[access-guard] prereq SBT RPC error — failing closed:", err);
    return false;
  }
}

export interface PriceQuote {
  contentId: number;
  /** KAL amount in wei (18-decimal bigint string) */
  priceWei: string;
  /** KAL amount as a human-readable number (for display) */
  priceKal: number;
  expiry: number;
  nonce: string;
  signature: string;
}

const QUOTE_TTL_SECONDS = 600; // 10 minutes

/**
 * Sign a price quote for a paid course.
 * The buyer presents this to KalPaywall.purchase().
 *
 * Returns null when the oracle wallet is not configured.
 */
export async function signPriceQuote(
  buyer: string,
  contentId: number,
  kalPrice: number
): Promise<PriceQuote | null> {
  const wallet = getWallet();
  if (!wallet) return null;

  const verifyingContract = cfgPaywall();
  const cid = cfgChainId();
  if (!verifyingContract || !cid) {
    throw new Error("EIP-712 quote signing requires PAYWALL_ADDRESS + CHAIN_ID (env or deployments/*.json)");
  }

  const expiry = Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS;
  const nonce = ethers.hexlify(randomBytes(32));
  const priceWei = ethers.parseEther(String(kalPrice)).toString();

  const domain = { name: "KalPaywall", version: "1", chainId: cid, verifyingContract };
  const signature = await wallet.signTypedData(domain, QUOTE_TYPES, {
    buyer,
    contentId: BigInt(contentId),
    price: BigInt(priceWei),
    expiry: BigInt(expiry),
    nonce,
  });

  return { contentId, priceWei, priceKal: kalPrice, expiry, nonce, signature };
}
