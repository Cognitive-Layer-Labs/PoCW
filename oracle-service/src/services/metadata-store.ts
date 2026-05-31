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

// ─── SVG badge ───────────────────────────────────────────────────────────────

const BLOOM_ORDER = ["Remember", "Understand", "Apply", "Analyze", "Evaluate", "Create"];
const SCORE_COLORS: Array<[number, string]> = [
  [80, "#22c55e"],  // green
  [50, "#a78bfa"],  // purple
  [0,  "#ef4444"],  // red
];

function scoreColor(score: number): string {
  return (SCORE_COLORS.find(([min]) => score >= min) ?? SCORE_COLORS[2])[1];
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function buildTokenSvg(profile: CognitiveProfile): string {
  const color   = scoreColor(profile.score);
  const label   = profile.passed ? "PASSED" : "FAILED";
  const bloom   = profile.bloomLevelsReached.length > 0
    ? profile.bloomLevelsReached[profile.bloomLevelsReached.length - 1]
    : "—";
  const title   = truncate(profile.title || `Content #${profile.contentId}`, 28);

  // Bloom progress bar — filled segments
  const bloomIdx  = BLOOM_ORDER.indexOf(bloom);
  const barWidth  = 140;
  const segW      = Math.floor(barWidth / BLOOM_ORDER.length) - 2;
  const bars = BLOOM_ORDER.map((_, i) => {
    const x = 30 + i * (segW + 2);
    const fill = i <= bloomIdx ? color : "#1e1b4b";
    return `<rect x="${x}" y="158" width="${segW}" height="5" rx="2" fill="${fill}"/>`;
  }).join("");

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">',
    '<rect width="200" height="200" rx="14" fill="#0c0c12"/>',
    '<rect x="1" y="1" width="198" height="198" rx="13" fill="none" stroke="#1e1b4b" stroke-width="1"/>',

    // Header
    `<text x="100" y="26" text-anchor="middle" font-family="monospace" font-size="11" fill="#7c3aed" font-weight="bold" letter-spacing="2">PoCW</text>`,

    // Score circle
    `<circle cx="100" cy="85" r="42" fill="none" stroke="${color}" stroke-width="2.5" opacity="0.3"/>`,
    `<circle cx="100" cy="85" r="36" fill="#0f0f1a"/>`,
    `<text x="100" y="80" text-anchor="middle" font-family="monospace" font-size="26" font-weight="bold" fill="${color}">${profile.score}</text>`,
    `<text x="100" y="96" text-anchor="middle" font-family="monospace" font-size="9" fill="#64748b">/100</text>`,

    // Pass/fail badge
    `<rect x="68" y="108" width="64" height="16" rx="8" fill="${profile.passed ? "#14532d" : "#450a0a"}"/>`,
    `<text x="100" y="120" text-anchor="middle" font-family="monospace" font-size="9" font-weight="bold" fill="${color}">${label}</text>`,

    // Title
    `<text x="100" y="142" text-anchor="middle" font-family="monospace" font-size="8" fill="#94a3b8">${title}</text>`,

    // Bloom bar
    `<text x="30" y="155" font-family="monospace" font-size="7" fill="#3b3b5c">bloom: ${bloom}</text>`,
    bars,

    // θ / SE footer
    `<text x="30" y="185" font-family="monospace" font-size="7" fill="#3b3b5c">θ=${profile.theta.toFixed(2)}  SE=${profile.se.toFixed(2)}  Q=${profile.questionCount}</text>`,

    '</svg>',
  ].join("");
}

// ─── ERC-1155 metadata ───────────────────────────────────────────────────────

/**
 * Build the ERC-1155 metadata JSON for a PoCW SBT.
 */
export function buildErc1155Metadata(profile: CognitiveProfile): Erc1155Metadata {
  const highestBloom = profile.bloomLevelsReached.length > 0
    ? profile.bloomLevelsReached[profile.bloomLevelsReached.length - 1]
    : "Remember";

  const svg = buildTokenSvg(profile);
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

  return {
    name: profile.title || `PoCW #${profile.contentId}`,
    description: `Demonstrated knowledge of "${profile.title || `content #${profile.contentId}`}". Score: ${profile.score}/100. Highest Bloom level: ${highestBloom}. Issued by PoCW oracle ${profile.oracleAddress}.`,
    image,
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
