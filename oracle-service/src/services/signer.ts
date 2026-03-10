import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const { ORACLE_PRIVATE_KEY } = process.env;

if (!ORACLE_PRIVATE_KEY) {
  throw new Error("ORACLE_PRIVATE_KEY not set");
}

const wallet = new ethers.Wallet(ORACLE_PRIVATE_KEY);

export function getOracleAddress(): string {
  return wallet.address;
}

export async function signResult(
  userAddress: string,
  contentId: number,
  score: number
): Promise<string> {
  const hash = ethers.solidityPackedKeccak256(
    ["address", "uint256", "uint256"],
    [userAddress, contentId, score]
  );
  return wallet.signMessage(ethers.getBytes(hash));
}

