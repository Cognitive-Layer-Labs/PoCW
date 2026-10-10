/**
 * Stubs for the model transports: OpenRouter chat (via the injectable OpenAI client) and the
 * decisions API (via the injectable fetch). Nothing here touches the network.
 */
import * as llmClient from "../../src/services/llm-client";
import { __setDecisionsFetchForTest, __resetDecisionsBreakerForTest } from "../../src/services/decisions-client";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export interface DecisionsCall {
  url: string;
  headers: Record<string, string>;
  body: { model: string; state: unknown; questions: Record<string, any> };
}

/**
 * Route decisions calls to `handler` (return a response body, a Response, or throw).
 * Sets OPENROUTER_API_KEY (the client refuses to call without one).
 */
export function stubDecisions(handler: (body: DecisionsCall["body"], n: number) => unknown): DecisionsCall[] {
  const calls: DecisionsCall[] = [];
  process.env.OPENROUTER_API_KEY = "test-key";
  __resetDecisionsBreakerForTest();
  __setDecisionsFetchForTest(async (url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const out = await handler(body, calls.length);
    return out instanceof Response ? out : jsonResponse(out);
  });
  return calls;
}

/** Back to the test default: decisions disabled, no key. */
export function restoreDecisions(): void {
  __setDecisionsFetchForTest(async () => new Response("network disabled in tests", { status: 400 }));
  __resetDecisionsBreakerForTest();
  delete process.env.OPENROUTER_API_KEY;
}

/** A decisions answer body: choices per question name ({ name: [choice, confidence] }). */
export function decisionsBody(choices: Record<string, [string, number]>, cost = 0.00002): unknown {
  const answers: Record<string, unknown> = {};
  for (const [name, [choice, confidence]] of Object.entries(choices)) {
    answers[name] = { type: "choice", choice, probabilities: { [choice]: confidence }, confidence };
  }
  return {
    model: "typesafe/jev-1.13-20260917",
    answers,
    usage: { input_tokens: 500, output_tokens: 70, cost },
    id: "gen-dec-test",
    provider: "TypeSafe",
  };
}

export interface ChatCall {
  body: Record<string, any>;
  system: string;
  user: string;
}

/**
 * Route chat completions to `handler` (returns the message content as a string or an object to
 * JSON-encode; throw to simulate an API error). Responses carry model + usage like OpenRouter's.
 */
export function stubChat(handler: (call: ChatCall, n: number) => unknown, model = "stub/model"): ChatCall[] {
  const calls: ChatCall[] = [];
  llmClient.__setOpenAIClientProviderForTest(() => ({
    chat: {
      completions: {
        create: async (body: Record<string, any>) => {
          const call: ChatCall = {
            body,
            system: body.messages?.[0]?.content ?? "",
            user: body.messages?.[body.messages.length - 1]?.content ?? "",
          };
          calls.push(call);
          const out = await handler(call, calls.length);
          const content = typeof out === "string" ? out : JSON.stringify(out);
          return {
            model,
            choices: [{ message: { content } }],
            usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
          };
        },
      },
    },
  } as any));
  return calls;
}

/** Back to a client that fails like a missing key would (no network). */
export function restoreChat(): void {
  llmClient.__setOpenAIClientProviderForTest(() => {
    throw new Error("OPENROUTER_API_KEY missing");
  });
}
