/**
 * Mock IPFS Store
 *
 * Simulates IPFS storage by writing JSON files locally.
 * Interface is ready for replacement with Pinata / web3.storage.
 */

import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";

export interface CognitiveProfile {
  theta: number;
  se: number;
  score: number;
  questionCount: number;
  bloomLevelsReached: string[];
  scoreBreakdown: Array<{
    question: string;
    score: number;
    difficulty: number;
    bloomLevel: string;
    correct: boolean;
  }>;
  contentUrl: string;
  contentId: number;
  userAddress: string;
  timestamp: string;
}

const DATA_DIR = path.resolve(__dirname, "..", "..", "data", "ipfs-mock");

/**
 * Upload a cognitive profile to "IPFS" (mock).
 * Returns a fake IPFS CID based on content hash.
 */
export async function uploadCognitiveProfile(
  profile: CognitiveProfile
): Promise<string> {
  const json = JSON.stringify(profile, null, 2);
  const hash = createHash("sha256").update(json).digest("hex");
  const cid = `Qm${hash.slice(0, 44)}`;

  mkdirSync(DATA_DIR, { recursive: true });

  const filePath = path.join(DATA_DIR, `${cid}.json`);
  writeFileSync(filePath, json, "utf8");

  return `ipfs://${cid}`;
}
