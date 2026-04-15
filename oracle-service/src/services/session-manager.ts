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
 */
export function selectChunkIndex(chunkUsageCount: number[]): number {
  const maxUsage = Math.max(...chunkUsageCount);
  const weights = chunkUsageCount.map(u => maxUsage + 1 - u);
  const cumWeights: number[] = [];
  let sum = 0;
  for (const w of weights) {
    sum += w;
    cumWeights.push(sum);
  }
  const r = Math.random() * sum;
  for (let i = 0; i < cumWeights.length; i++) {
    if (r < cumWeights[i]) return i;
  }
  return weights.length - 1;
}
