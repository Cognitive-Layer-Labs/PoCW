/**
 * Metadata Store — Base64 Data URI Mode
 *
 * Builds ERC-1155 metadata and encodes it as a base64 data URI.
 * Metadata lives on-chain — no external storage required.
 * Cognitive profiles are written to local disk for off-chain analysis.
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
  passed: boolean;
  converged: boolean;
  confidenceInterval: [number, number];
  questionTypes: string[];
  title: string;
  source: string;
  oracleAddress: string;
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

export interface Erc1155Metadata {
  name: string;
  description: string;
  attributes: Array<{ trait_type: string; value: string | number }>;
}

export interface UploadResult {
  /** data:application/json;base64,... — stored on-chain as the token URI */
  dataUri: string;
  /** SHA-256 hex digest of the metadata JSON, used as a content identifier */
  cid: string;
}

const DATA_DIR = path.resolve(__dirname, "..", "..", "data", "profiles");

// ─── ERC-1155 metadata ───────────────────────────────────────────────────────

/**
 * Build the minimal ERC-1155 metadata JSON for a PoCW SBT.
 * Keeps only essential fields to stay under ~1 KB (base64 ~1.3 KB).
 */
export function buildErc1155Metadata(profile: CognitiveProfile): Erc1155Metadata {
  const highestBloom = profile.bloomLevelsReached.length > 0
    ? profile.bloomLevelsReached[profile.bloomLevelsReached.length - 1]
    : "Remember";

  return {
    name: profile.title || `PoCW #${profile.contentId}`,
    description: profile.source || `Demonstrated knowledge of content #${profile.contentId}`,
    attributes: [
      { trait_type: "Score", value: profile.score },
      { trait_type: "Theta", value: Number(profile.theta.toFixed(3)) },
      { trait_type: "Std Error", value: Number(profile.se.toFixed(3)) },
      { trait_type: "Questions", value: profile.questionCount },
      { trait_type: "Bloom", value: highestBloom },
      { trait_type: "Content ID", value: profile.contentId },
      { trait_type: "Timestamp", value: profile.timestamp },
      { trait_type: "Passed", value: profile.passed ? 1 : 0 },
      { trait_type: "Title", value: profile.title },
      { trait_type: "Source", value: profile.source },
      { trait_type: "Oracle", value: profile.oracleAddress },
      { trait_type: "QTypes", value: profile.questionTypes.join(",") },
      { trait_type: "CI Low", value: Number(profile.confidenceInterval[0].toFixed(1)) },
      { trait_type: "CI High", value: Number(profile.confidenceInterval[1].toFixed(1)) },
      { trait_type: "Converged", value: profile.converged ? 1 : 0 },
    ],
  };
}

/**
 * Encode ERC-1155 metadata as a base64 data URI.
 * Returns the data URI and a SHA-256 content hash.
 */
export function buildDataUri(metadata: Erc1155Metadata): UploadResult {
  const json = JSON.stringify(metadata);
  const base64 = Buffer.from(json).toString("base64");
  const hash = createHash("sha256").update(json).digest("hex");

  return {
    dataUri: `data:application/json;base64,${base64}`,
    cid: hash,
  };
}

/**
 * Write cognitive profile JSON to local disk for off-chain analysis.
 * Not included in the on-chain token — retained for provenance.
 */
export function saveCognitiveProfile(profile: CognitiveProfile): string {
  const json = JSON.stringify(profile, null, 2);
  const hash = createHash("sha256").update(json).digest("hex");

  mkdirSync(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, `profile-${hash}.json`);
  writeFileSync(filePath, json, "utf8");

  return filePath;
}
