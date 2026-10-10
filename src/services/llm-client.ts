/**
 * Shared LLM Client (OpenRouter via OpenAI SDK)
 *
 * Singleton client with circuit breaker, retry, and timeout.
 * WS5: All LLM calls must go through callLLM() — never call getOpenAIClient() directly.
 */

import { OpenAI } from "openai";
import type { ChatCompletion, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { PoCWError } from "../sdk/types";
import type { ModelSpec } from "./ai-config";
import { recordCall } from "./usage-store";

let openaiClient: OpenAI | null = null;

let openAIProvider: () => OpenAI = () => {
  if (!openaiClient) {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY missing");
    }

    openaiClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      timeout: 30_000,
      maxRetries: 0, // we handle retries ourselves
    });
  }
  return openaiClient;
};

export function getOpenAIClient(): OpenAI {
  return openAIProvider();
}

/* test-only injection */
export function __setOpenAIClientProviderForTest(
  provider: () => OpenAI
): void {
  openAIProvider = provider;
}

// ─── Circuit Breaker (WS5) ──────────────────────────────────────────────────

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly halfOpenProbes = 1
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkState();

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private checkState(): void {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.cooldownMs) {
        this.state = "HALF_OPEN";
        this.failureCount = 0;
      } else {
        throw new PoCWError("LLM_ERROR", "LLM temporarily unavailable");
      }
    }
  }

  private onSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.state = "CLOSED";
    }
    this.failureCount = 0;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.lastFailureTime = Date.now();
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }
}

const breaker = new CircuitBreaker(5, 30_000, 1);

// ─── Retry with jittered backoff ────────────────────────────────────────────

const MAX_RETRIES = 2;

function isRetryable(err: unknown): boolean {
  if (err instanceof PoCWError && err.code === "LLM_ERROR") return false; // circuit open
  if (err instanceof OpenAI.APIError) {
    if (err.status === 429) return true;
    if (err.status && err.status >= 500) return true;
  }
  if (err instanceof Error && (err.message.includes("fetch") || err.message.includes("network") || err.message.includes("timeout"))) {
    return true;
  }
  return false;
}

function jitterBackoff(attempt: number): number {
  return 500 * Math.pow(2, attempt) + Math.random() * 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call the LLM through the circuit breaker with retry.
 * Each dedup iteration in the question generator should be one breaker call.
 */
export async function callLLM<T>(fn: (client: OpenAI) => Promise<T>): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await breaker.execute(() => fn(getOpenAIClient()));
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      if (attempt < MAX_RETRIES) {
        await sleep(jitterBackoff(attempt));
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("LLM call failed after retries");
}

// ─── Task calls (model spec → OpenRouter request, call log) ─────────────────

export interface ChatRequest {
  messages: ChatCompletionMessageParam[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
  seed?: number;
}

export interface ChatCallOptions {
  /** Caller-chosen model (config.model with ALLOW_MODEL_OVERRIDE): replaces the configured model,
   *  its fallbacks and its reasoning setting. */
  modelOverride?: string;
  /** Through the circuit breaker + retry (default). KG extraction and titles call once — they
   *  have their own retry / fallback. */
  resilient?: boolean;
  /** Outcome stored with the call-log row (e.g. "escalated:low_confidence"). */
  outcome?: string;
}

/**
 * OpenRouter request body for a task: "models" = [primary, ...fallbacks] (OpenRouter tries them in
 * order), "reasoning" from the config, "usage": { include: true } so the response carries usage.cost.
 */
export function buildChatBody(spec: ModelSpec, req: ChatRequest, modelOverride?: string): Record<string, unknown> {
  const models = modelOverride ? [modelOverride] : [spec.model, ...spec.fallbacks];
  const body: Record<string, unknown> = { model: models[0], ...req, usage: { include: true } };
  if (models.length > 1) body.models = models;
  if (spec.reasoning && !modelOverride) body.reasoning = spec.reasoning;
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return body;
}

function describeError(err: unknown): string {
  if (err instanceof OpenAI.APIError) return `${err.status ?? "?"} ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * One chat completion for `task` (kg | question | grade | grade_escalation | title ...), recorded
 * in the call log (model actually used, tokens, usage.cost, latency, ok/error, resource/session).
 */
export type TaskCompletion = ChatCompletion & {
  /** Call-log row id of this completion (for setCallOutcome), null when the log is not attached. */
  callId: number | null;
};

export async function chatCompletion(
  task: string,
  spec: ModelSpec,
  req: ChatRequest,
  opts: ChatCallOptions = {},
): Promise<TaskCompletion> {
  const body = buildChatBody(spec, req, opts.modelOverride);
  const requested = String(body.model);
  const once = async (client: OpenAI): Promise<TaskCompletion> => {
    const t0 = Date.now();
    try {
      const completion = (await client.chat.completions.create(body as never)) as unknown as ChatCompletion;
      const usage = ((completion as { usage?: Record<string, unknown> }).usage ?? {}) as Record<string, unknown>;
      const callId = recordCall({
        task,
        model: typeof completion?.model === "string" && completion.model ? completion.model : requested,
        requestedModel: requested,
        inputTokens: usage.prompt_tokens as number | undefined,
        outputTokens: usage.completion_tokens as number | undefined,
        costUsd: usage.cost as number | undefined,
        latencyMs: Date.now() - t0,
        ok: true,
        outcome: opts.outcome,
      });
      return Object.assign(completion, { callId });
    } catch (err) {
      recordCall({ task, requestedModel: requested, latencyMs: Date.now() - t0, ok: false, error: describeError(err) });
      throw err;
    }
  };
  return opts.resilient === false ? once(getOpenAIClient()) : callLLM(once);
}

/**
 * JSON object from an LLM reply: plain JSON, JSON in a ```json fence, or the outermost {...} in
 * surrounding prose (models without native JSON mode). Throws SyntaxError when there is none.
 */
export function extractJSONObject(text: string): Record<string, unknown> {
  const trimmed = (text ?? "").trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) candidates.push(fence[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  throw new SyntaxError("No JSON object in LLM response");
}
