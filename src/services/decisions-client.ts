/**
 * OpenRouter decisions API client — "System One" models such as typesafe/jev-1.13.
 *
 * Jev is not a chat model (chat/completions answers 400 "decisions model … use /api/alpha/decisions").
 * A call sends a context ("state") and several named questions, and gets one answer per question:
 *
 *   POST https://openrouter.ai/api/alpha/decisions   (Authorization: Bearer OPENROUTER_API_KEY)
 *   { model, state: string | object | array, questions: { <name>: <question>, ... } }
 *
 *   choice: { type: "choice", instructions, criteria: { <option>: <description>, ... } }
 *           → { type: "choice", choice: "<option>", probabilities: {...}, confidence: 0..1 }
 *   score:  { type: "score", instructions, criteria: [<level 0>, <level 1>, ...] }   (ordinal scale)
 *           → { type: "score", score: <float index>, legend: {...}, probabilities: {...}, confidence }
 *
 *   response: { model, answers: {...}, usage: { input_tokens, output_tokens, cost }, id, provider }
 *
 * Calls time out after 10 s and are retried once (network errors, timeouts, 429, 5xx). After three
 * failed calls in a row the client fails fast for 60 s. Callers must treat every DecisionsError as
 * "no decision" and fall back — a Jev failure never fails a user's request.
 */

import { recordCall } from "./usage-store";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const DECISIONS_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 250;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;

export type DecisionInstructions = string | Record<string, unknown> | unknown[];

export interface ChoiceQuestion {
  type: "choice";
  instructions: DecisionInstructions;
  /** Option name → description. */
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: DecisionInstructions;
  /** Ordinal levels, lowest first. */
  criteria: string[];
}

export type DecisionQuestion = ChoiceQuestion | ScoreQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type DecisionAnswer = ChoiceAnswer | ScoreAnswer;

export interface DecideRequest {
  model: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

export interface DecideOptions {
  /** Call-log task name (question_check, grade, ...). */
  task: string;
  timeoutMs?: number;
  /** Retries after the first attempt (default 1). */
  retries?: number;
}

export interface DecideResult {
  /** Model that answered (e.g. "typesafe/jev-1.13-20260917"). */
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  id?: string;
  provider?: string;
  /** Call-log row id (for setCallOutcome), null when the log is not attached. */
  callId: number | null;
  latencyMs: number;
}

export class DecisionsError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retryable = false) {
    super(message);
    this.name = "DecisionsError";
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
const realFetch: FetchFn = (url, init) => fetch(url, init);
let fetchImpl: FetchFn = realFetch;

/** Test-only: replace the HTTP transport (null restores the real fetch). */
export function __setDecisionsFetchForTest(fn: FetchFn | null): void {
  fetchImpl = fn ?? realFetch;
}

let consecutiveFailures = 0;
let openUntil = 0;

/** Test-only: close the fail-fast breaker. */
export function __resetDecisionsBreakerForTest(): void {
  consecutiveFailures = 0;
  openUntil = 0;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

function numberMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (isNum(x)) out[k] = x;
  }
  return out;
}

function confidenceOf(raw: Record<string, unknown>, probabilities: Record<string, number>): number {
  if (isNum(raw.confidence)) return clamp01(raw.confidence);
  const ps = Object.values(probabilities);
  return ps.length ? clamp01(Math.max(...ps)) : 0;
}

/** Validate a decisions response against the questions that were asked. Throws DecisionsError. */
export function parseDecisionsResponse(
  json: unknown,
  questions: Record<string, DecisionQuestion>,
): Omit<DecideResult, "callId" | "latencyMs"> {
  if (!json || typeof json !== "object") throw new DecisionsError("decisions response is not an object");
  const body = json as Record<string, unknown>;
  const rawAnswers = body.answers;
  if (!rawAnswers || typeof rawAnswers !== "object") throw new DecisionsError("decisions response has no answers");
  const answers: Record<string, DecisionAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const raw = (rawAnswers as Record<string, unknown>)[name];
    if (!raw || typeof raw !== "object") throw new DecisionsError(`decisions response is missing answer "${name}"`);
    const a = raw as Record<string, unknown>;
    const probabilities = numberMap(a.probabilities);
    if (q.type === "choice") {
      if (typeof a.choice !== "string" || !(a.choice in q.criteria)) {
        throw new DecisionsError(`decisions answer "${name}" has an unknown choice ${JSON.stringify(a.choice)}`);
      }
      answers[name] = { type: "choice", choice: a.choice, probabilities, confidence: confidenceOf(a, probabilities) };
    } else {
      if (!isNum(a.score)) throw new DecisionsError(`decisions answer "${name}" has no numeric score`);
      const legend: Record<string, string> = {};
      if (a.legend && typeof a.legend === "object") {
        for (const [k, v] of Object.entries(a.legend as Record<string, unknown>)) legend[k] = String(v);
      }
      answers[name] = { type: "score", score: a.score, legend, probabilities, confidence: confidenceOf(a, probabilities) };
    }
  }
  const usage = (body.usage && typeof body.usage === "object" ? body.usage : {}) as Record<string, unknown>;
  return {
    model: typeof body.model === "string" ? body.model : "",
    answers,
    usage: {
      inputTokens: isNum(usage.input_tokens) ? usage.input_tokens : null,
      outputTokens: isNum(usage.output_tokens) ? usage.output_tokens : null,
      costUsd: isNum(usage.cost) ? usage.cost : null,
    },
    id: typeof body.id === "string" ? body.id : undefined,
    provider: typeof body.provider === "string" ? body.provider : undefined,
  };
}

function toDecisionsError(err: unknown): DecisionsError {
  if (err instanceof DecisionsError) return err;
  const e = err as { name?: string; message?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return new DecisionsError("decisions API timed out", undefined, true);
  return new DecisionsError(`decisions API unreachable: ${e?.message ?? String(err)}`, undefined, true);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** One decisions call (with one retry). Throws DecisionsError on any failure. */
export async function decide(req: DecideRequest, opts: DecideOptions): Promise<DecideResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new DecisionsError("OPENROUTER_API_KEY missing");
  if (Date.now() < openUntil) throw new DecisionsError("decisions API skipped after repeated failures (cooling down)");

  const retries = opts.retries ?? 1;
  const timeoutMs = opts.timeoutMs ?? DECISIONS_TIMEOUT_MS;
  const payload = JSON.stringify({ model: req.model, state: req.state, questions: req.questions });
  let lastErr: DecisionsError = new DecisionsError("decisions call not attempted");

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    const t0 = Date.now();
    let parsedUsage: DecideResult["usage"] | null = null;
    let answeredModel: string | undefined;
    try {
      const res = await fetchImpl(DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new DecisionsError(`decisions API ${res.status}: ${text.slice(0, 200)}`, res.status, retryable);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new DecisionsError("decisions API returned invalid JSON", res.status);
      }
      const raw = json as { usage?: Record<string, unknown>; model?: unknown };
      answeredModel = typeof raw?.model === "string" ? raw.model : undefined;
      parsedUsage = {
        inputTokens: isNum(raw?.usage?.input_tokens) ? raw.usage!.input_tokens as number : null,
        outputTokens: isNum(raw?.usage?.output_tokens) ? raw.usage!.output_tokens as number : null,
        costUsd: isNum(raw?.usage?.cost) ? raw.usage!.cost as number : null,
      };
      const parsed = parseDecisionsResponse(json, req.questions);
      const latencyMs = Date.now() - t0;
      const callId = recordCall({
        task: opts.task,
        model: parsed.model || req.model,
        requestedModel: req.model,
        inputTokens: parsed.usage.inputTokens,
        outputTokens: parsed.usage.outputTokens,
        costUsd: parsed.usage.costUsd,
        latencyMs,
        ok: true,
      });
      consecutiveFailures = 0;
      return { ...parsed, callId, latencyMs };
    } catch (err) {
      lastErr = toDecisionsError(err);
      // A 200 with an unusable body still cost money: keep its usage on the error row.
      recordCall({
        task: opts.task,
        model: answeredModel ?? req.model,
        requestedModel: req.model,
        inputTokens: parsedUsage?.inputTokens,
        outputTokens: parsedUsage?.outputTokens,
        costUsd: parsedUsage?.costUsd,
        latencyMs: Date.now() - t0,
        ok: false,
        error: lastErr.message,
      });
      if (!lastErr.retryable) break;
    }
  }

  if (++consecutiveFailures >= BREAKER_THRESHOLD) {
    openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    consecutiveFailures = 0;
    console.warn(`[decisions] ${BREAKER_THRESHOLD} failed calls in a row — skipping the decisions API for ${BREAKER_COOLDOWN_MS / 1000} s`);
  }
  throw lastErr;
}

/** The choice answer `name` of a result (throws DecisionsError when it is not a choice). */
export function choiceAnswer(result: Pick<DecideResult, "answers">, name: string): ChoiceAnswer {
  const a = result.answers[name];
  if (!a || a.type !== "choice") throw new DecisionsError(`no choice answer "${name}"`);
  return a;
}
