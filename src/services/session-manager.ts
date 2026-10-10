/**
 * Session Manager — Utilities Only
 *
 * 3.6: Dead code removed. The full AdaptiveSession implementation
 * (createSession, submitAnswer, getSessionResult, sessions Map, cleanup timer)
 * has been superseded by sdk/verify-session.ts and was removed.
 *
 * Only the two utility functions still referenced by active code remain:
 *   - contentUrlToId  (used by sdk/index.ts)
 *   - selectChunkIndex (used by sdk/verify-session.ts)
 */

import { createHash } from "crypto";

/**
 * Deterministic contentId from URL.
 * Same URL always maps to the same contentId, enabling graphExists() to work
 * correctly for cached knowledge graphs.
 */
export function contentUrlToId(url: string): number {
  const hash = createHash("sha256").update(url).digest();
  // Use first 6 bytes as a positive integer (48-bit, safe for JS number)
  return hash.readUIntBE(0, 6);
}

/**
 * Select a chunk index weighted toward least-used chunks.
 * Uses cumulative-sum approach to avoid floating-point drift.
 * With `candidates` (e.g. the chunks that mention the targeted concept) the choice is restricted
 * to those indices; an empty/invalid candidate list means "any chunk".
 */
export function selectChunkIndex(chunkUsageCount: number[], candidates?: number[]): number {
  const pool = (candidates ?? []).filter(i => Number.isInteger(i) && i >= 0 && i < chunkUsageCount.length);
  const indices = pool.length > 0 ? pool : chunkUsageCount.map((_, i) => i);
  let maxUsage = 0;
  for (const i of indices) maxUsage = Math.max(maxUsage, chunkUsageCount[i]);
  const cumWeights: number[] = [];
  let sum = 0;
  for (const i of indices) {
    sum += maxUsage + 1 - chunkUsageCount[i];
    cumWeights.push(sum);
  }
  const r = Math.random() * sum;
  for (let k = 0; k < cumWeights.length; k++) {
    if (r < cumWeights[k]) return indices[k];
  }
  return indices[indices.length - 1];
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "over", "under", "about", "their",
  "between", "within", "without", "concept", "theory", "role", "nature",
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Indices of chunks that mention a concept label (case-insensitive): the full label first; if
 * no chunk has it, chunks containing every significant word (≥ 4 letters); then each such word
 * alone, longest first. Empty when nothing matches (caller then uses any chunk). Used so a question
 * about a concept of a long book is generated from a passage that actually discusses it.
 */
export function chunksMentioning(chunks: string[], label: string | undefined): number[] {
  const clean = (label ?? "").replace(/\([^)]*\)/g, " ").trim();
  if (!clean) return [];
  const find = (patterns: RegExp[]): number[] => {
    const out: number[] = [];
    chunks.forEach((c, i) => { if (c && patterns.every(p => p.test(c))) out.push(i); });
    return out;
  };
  const full = find([new RegExp(escapeRegExp(clean), "i")]);
  if (full.length > 0) return full;
  const words = clean.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4 && !STOPWORDS.has(w.toLowerCase()));
  if (words.length === 0) return [];
  const wordRe = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(w)}`, "iu");
  if (words.length > 1) {
    const all = find(words.map(wordRe));
    if (all.length > 0) return all;
  }
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    const hits = find([wordRe(w)]);
    if (hits.length > 0) return hits;
  }
  return [];
}
