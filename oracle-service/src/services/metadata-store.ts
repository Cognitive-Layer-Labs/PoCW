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
  bloomCoverage: Record<string, number>;
  aberrant: boolean;
  passed: boolean;
  converged: boolean;
  confidenceInterval: [number, number];
  questionTypes: string[];
  title: string;
  source: string;
  oracleAddress: string;
  scoreBreakdown: Array<{
    question: string;
    userAnswer: string;
    score: number;
    difficulty: number;
    bloomLevel: string;
    correct: boolean;
    reasoning: string;
  }>;
  contentUrl: string;
  contentId: number;
  userAddress: string;
  timestamp: string;
}

export interface Erc1155Metadata {
  name: string;
  description: string;
  image: string;
  external_url?: string;
  attributes: Array<{ trait_type: string; value: string | number }>;
}

export interface UploadResult {
  /** data:application/json;base64,... — stored on-chain as the token URI */
  dataUri: string;
  /** SHA-256 hex digest of the metadata JSON, used as a content identifier */
  cid: string;
}

const DATA_DIR = path.resolve(__dirname, "..", "..", "data", "profiles");

// On-chain SVG logo (data URI) — self-contained, renders in explorers/wallets without an
// external host. Matches the PoCW collection brand (see PoCW_SBT.contractURI()).
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 680">' +
  '<rect width="680" height="680" fill="#0c0c12"/>' +
  '<polygon points="340,181 478,260 478,420 340,499 202,420 202,260" fill="none" stroke="#F92672" stroke-width="1.5" opacity="0.22"/>' +
  '<polygon points="340,253 415,296 415,384 340,427 265,384 265,296" fill="none" stroke="#F92672" stroke-width="1" opacity="0.10"/>' +
  '<line x1="340" y1="340" x2="340" y2="50" stroke="#66D9EF" stroke-width="1.5" opacity="0.38"/>' +
  '<line x1="340" y1="340" x2="591" y2="485" stroke="#A6E22E" stroke-width="1.5" opacity="0.38"/>' +
  '<line x1="340" y1="340" x2="89" y2="485" stroke="#AE81FF" stroke-width="1.5" opacity="0.38"/>' +
  '<polygon points="340,61 581,202 581,478 340,619 99,478 99,202" fill="none" stroke="#F92672" stroke-width="2" opacity="0.35"/>' +
  '<polygon points="340,50 591,195 591,485 340,630 89,485 89,195" fill="none" stroke="#F92672" stroke-width="8"/>' +
  '<circle cx="340" cy="50" r="12" fill="#66D9EF"/><circle cx="340" cy="50" r="5" fill="#0c0c12"/>' +
  '<circle cx="591" cy="195" r="12" fill="#A6E22E"/><circle cx="591" cy="195" r="5" fill="#0c0c12"/>' +
  '<circle cx="591" cy="485" r="12" fill="#AE81FF"/><circle cx="591" cy="485" r="5" fill="#0c0c12"/>' +
  '<circle cx="340" cy="630" r="12" fill="#66D9EF"/><circle cx="340" cy="630" r="5" fill="#0c0c12"/>' +
  '<circle cx="89" cy="485" r="12" fill="#A6E22E"/><circle cx="89" cy="485" r="5" fill="#0c0c12"/>' +
  '<circle cx="89" cy="195" r="12" fill="#AE81FF"/><circle cx="89" cy="195" r="5" fill="#0c0c12"/>' +
  '<text x="340" y="348" text-anchor="middle" font-family="monospace" font-size="112" fill="#F92672" font-weight="bold" letter-spacing="5">PoCW</text>' +
  '<text x="340" y="395" text-anchor="middle" font-family="monospace" font-size="25" fill="#64748b" letter-spacing="13">SOULBOUND</text>' +
  '<text x="340" y="448" text-anchor="middle" font-family="monospace" font-size="16" fill="#F92672" opacity="0.45" letter-spacing="24">&#9670; &#9670; &#9670;</text>' +
  '</svg>';
const TOKEN_IMAGE_URL = `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString("base64")}`;

// ─── ERC-1155 metadata ───────────────────────────────────────────────────────

/**
 * Build the ERC-1155 metadata JSON for a PoCW SBT.
 */
export function buildErc1155Metadata(profile: CognitiveProfile): Erc1155Metadata {
  const highestBloom = profile.bloomLevelsReached.length > 0
    ? profile.bloomLevelsReached[profile.bloomLevelsReached.length - 1]
    : "Remember";

  return {
    name: "Proof of Cognitive Work",
    description: `Demonstrated knowledge of "${profile.title || `content #${profile.contentId}`}". Score: ${profile.score}/100. Highest Bloom level: ${highestBloom}. Issued by PoCW oracle ${profile.oracleAddress}.`,
    image: TOKEN_IMAGE_URL,
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
      { trait_type: "Aberrant", value: profile.aberrant ? 1 : 0 },
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
