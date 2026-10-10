import { ethers } from "ethers";
import { randomBytes } from "crypto";
import * as dotenv from "dotenv";
import * as path from "path";
import { controllerAddress, chainId } from "./chain-config";

dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

const { ORACLE_PRIVATE_KEY } = process.env;

const ATTESTATION_TYPES = {
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

if (!ORACLE_PRIVATE_KEY) {
  throw new Error("ORACLE_PRIVATE_KEY not set");
}

const wallet = new ethers.Wallet(ORACLE_PRIVATE_KEY);

export function getOracleAddress(): string {
  return wallet.address;
}

export interface SignedResult {
  signature: string;
  /** Unique bytes32 nonce (0x-prefixed hex) included in the signed payload — prevents replay. */
  nonce: string;
  /** Unix timestamp (seconds) after which the signature is invalid (default 24 h). */
  expiry: number;
}

/**
 * Sign a mint authorization as EIP-712 typed data matching PoCW_Controller:
 *   domain = ("PoCW","1", chainId, controllerAddress)
 *   Attestation(user, contentId, score, kalAmount, expiry, nonce, tokenUriHash)
 *
 * @param kalAmountWei  KAL reward in wei (18-dec), as a decimal string. "0" if none.
 * @param tokenUri      Base64 data URI of the ERC-1155 metadata (encoded before calling).
 */
export async function signMintAuthorization(
  userAddress: string,
  contentId: number,
  score: number,
  kalAmountWei: string,
  tokenUri: string,
  nonce?: string,
  expiry?: number
): Promise<SignedResult> {
  const _nonce = nonce ?? ethers.hexlify(randomBytes(32));
  const _expiry = expiry ?? Math.floor(Date.now() / 1000) + 86_400; // 24 h TTL
  const _score = Math.round(score);

  const verifyingContract = controllerAddress();
  const cid = chainId();
  if (!verifyingContract || !cid) {
    throw new Error("EIP-712 signing requires CONTROLLER_ADDRESS + CHAIN_ID (env or deployments/*.json)");
  }

  const domain = { name: "PoCW", version: "1", chainId: cid, verifyingContract };
  const value = {
    user: userAddress,
    contentId: BigInt(contentId),
    score: BigInt(_score),
    kalAmount: BigInt(kalAmountWei),
    expiry: BigInt(_expiry),
    nonce: _nonce,
    tokenUriHash: ethers.keccak256(ethers.toUtf8Bytes(tokenUri)),
  };
  const signature = await wallet.signTypedData(domain, ATTESTATION_TYPES, value);

  return { signature, nonce: _nonce, expiry: _expiry };
}
