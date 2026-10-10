/**
 * Live OpenRouter key status (GET https://openrouter.ai/api/v1/auth/key), cached ~60 s.
 * Used by GET /api/usage. Never throws: null when the key is missing or the call fails.
 */

export const KEY_STATUS_URL = "https://openrouter.ai/api/v1/auth/key";
const CACHE_MS = 60_000;
/** Failures are cached briefly so a dashboard refresh loop cannot hammer OpenRouter. */
const FAILURE_CACHE_MS = 15_000;
const TIMEOUT_MS = 5_000;

export interface KeyStatus {
  /** Credit limit of the key in USD; null = unlimited. */
  limitUsd: number | null;
  /** Total spent on the key in USD. */
  usageUsd: number;
  /** Credit left in USD; null = unlimited. */
  remainingUsd: number | null;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
const realFetch: FetchFn = (url, init) => fetch(url, init);
let fetchImpl: FetchFn = realFetch;
let cache: { at: number; ttl: number; value: KeyStatus | null } | null = null;

export function __setKeyStatusFetchForTest(fn: FetchFn | null): void {
  fetchImpl = fn ?? realFetch;
  cache = null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Map the auth/key response body to KeyStatus (null when it has no usage figure). */
export function parseKeyStatus(body: unknown): KeyStatus | null {
  const data = (body as { data?: Record<string, unknown> })?.data;
  if (!data || typeof data !== "object") return null;
  const usage = num(data.usage);
  if (usage === null) return null;
  const limit = num(data.limit);
  const remaining = num(data.limit_remaining) ?? (limit !== null ? Math.max(0, limit - usage) : null);
  return { limitUsd: limit, usageUsd: usage, remainingUsd: remaining };
}

export async function getKeyStatus(now = Date.now()): Promise<KeyStatus | null> {
  if (cache && now - cache.at < cache.ttl) return cache.value;
  const apiKey = process.env.OPENROUTER_API_KEY;
  let value: KeyStatus | null = null;
  if (apiKey) {
    try {
      const res = await fetchImpl(KEY_STATUS_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) value = parseKeyStatus(await res.json());
    } catch {
      value = null;
    }
  }
  cache = { at: now, ttl: value ? CACHE_MS : FAILURE_CACHE_MS, value };
  return value;
}
