/**
 * Shared LLM Client (OpenRouter via OpenAI SDK)
 *
 * Singleton client with circuit breaker, retry, and timeout.
 * WS5: All LLM calls must go through callLLM() — never call getOpenAIClient() directly.
 */

import { OpenAI } from "openai";
import { PoCWError } from "../sdk/types";

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
