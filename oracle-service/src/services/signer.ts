import { ethers } from "ethers";
import { randomBytes } from "crypto";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

const { ORACLE_PRIVATE_KEY } = process.env;

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
 * Sign a mint authorization.
 *
 * Signed payload matches PoCW_Controller.verifyAndMint on-chain:
 *   keccak256(abi.encode(user, contentId, score, nonce, expiry, keccak256(bytes(tokenUri))))
 *
 * Then signed with wallet.signMessage (eth_sign prefix).
 *
 * @param tokenUri  Base64 data URI (data:application/json;base64,...) of the ERC-1155 metadata.
 *                  Must be encoded before calling this function.
 */
export async function signMintAuthorization(
  userAddress: string,
  contentId: number,
  score: number,
  tokenUri: string,
  nonce?: string,
  expiry?: number
): Promise<SignedResult> {
  // Generate a 32-byte random nonce as 0x-prefixed hex
  const _nonce = nonce ?? ethers.hexlify(randomBytes(32));
  const _expiry = expiry ?? Math.floor(Date.now() / 1000) + 86_400; // 24 h TTL
  const _score = Math.round(score); // ensure integer before ABI encode

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  // Hash the tokenUri as bytes32 to handle dynamic-length string in abi.encode
  const tokenUriHash = ethers.keccak256(ethers.toUtf8Bytes(tokenUri));

  const encoded = abiCoder.encode(
    ["address", "uint256", "uint256", "bytes32", "uint256", "bytes32"],
    [userAddress, BigInt(contentId), BigInt(_score), _nonce, BigInt(_expiry), tokenUriHash]
  );
  const messageHash = ethers.keccak256(encoded);
  const signature = await wallet.signMessage(ethers.getBytes(messageHash));

  return { signature, nonce: _nonce, expiry: _expiry };
}
