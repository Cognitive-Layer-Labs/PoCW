/**
 * LLM title derivation for web pages / videos (title-model + title-prompt in the AI config).
 * Used at indexing time (sdk/index.ts) and by PATCH /api/index/:id/title (parser.rederiveTitle).
 */

import { chatCompletion } from "./llm-client";
import { DEFAULT_TITLE_PROMPT, promptFor, titleModelSpec } from "./ai-config";

/** Output budget: a title is ~20 tokens; reasoning models may spend a few more. */
const TITLE_MAX_TOKENS = 300;

export interface TitleInput {
  url: string;
  htmlTitle?: string | null;
  /** Extracted text (only the first 4 000 characters are sent). */
  text: string;
}

/** A clean title (5–199 characters) from the LLM, or null when the call fails or the reply is unusable. */
export async function deriveTitleWithLLM(input: TitleInput): Promise<string | null> {
  try {
    const prompt = [
      promptFor("title-prompt", DEFAULT_TITLE_PROMPT).trim(),
      `URL: ${input.url}`,
      input.htmlTitle ? `HTML <title>: ${input.htmlTitle}` : null,
      `Content excerpt:\n${input.text.slice(0, 4000)}`,
    ].filter(Boolean).join("\n");

    const completion = await chatCompletion("title", titleModelSpec(), {
      max_tokens: TITLE_MAX_TOKENS,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }, { resilient: false });
    const result = (completion.choices?.[0]?.message?.content ?? "")
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();
    if (result.length > 5 && result.length < 200) return result;
  } catch {
    // LLM unavailable — caller falls back
  }
  return null;
}
