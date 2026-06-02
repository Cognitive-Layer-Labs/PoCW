/**
 * IRT Predictor Client
 *
 * Calls the Python predictor sidecar (predictor_service.py) to get 2PL
 * IRT parameters for a generated question.
 *
 * Falls back gracefully (returns null) when the sidecar is unavailable —
 * the oracle service continues with default a=1.0 / type-based c / d=0.95.
 */

const PREDICTOR_URL = process.env.PREDICTOR_URL || "http://127.0.0.1:3001";
const TIMEOUT_MS = 3000;

export interface PredictorParams {
  a: number;   // discrimination
  b: number;   // difficulty
  c: number;   // lower asymptote
  d: number;   // upper asymptote
}

let _available: boolean | null = null; // null = unknown, probed lazily

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Predict IRT parameters for a question text + optional choices.
 * Returns null if the sidecar is unreachable or returns an error.
 */
export async function predictIRTParams(
  question: string,
  choices: string[] = []
): Promise<PredictorParams | null> {
  // Fast-fail if we already know the sidecar is down
  if (_available === false) return null;

  try {
    const resp = await fetchWithTimeout(`${PREDICTOR_URL}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, choices }),
    });

    if (!resp.ok) {
      _available = false;
      return null;
    }

    const data = await resp.json() as PredictorParams;
    _available = true;
    return { a: data.a, b: data.b, c: data.c, d: data.d };
  } catch {
    _available = false;
    return null;
  }
}

/** Reset availability cache (e.g. for testing). */
export function resetPredictorAvailability(): void {
  _available = null;
}
