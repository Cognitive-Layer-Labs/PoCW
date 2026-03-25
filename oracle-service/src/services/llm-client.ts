/**
 * Shared LLM Client (OpenRouter via OpenAI SDK)
 *
 * Singleton client used by all services that need LLM access:
 * kg-builder, question-generator, etc.
 */

import { OpenAI } from "openai";

let openaiClient: OpenAI | null = null;

let openAIProvider: () => OpenAI = () => {
  if (!openaiClient) {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY missing");
    }

    openaiClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1"
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
