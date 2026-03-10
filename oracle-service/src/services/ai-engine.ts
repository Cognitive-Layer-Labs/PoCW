import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { OpenAI } from "openai";
import { parseContentToText } from "./parser";

export type Challenge = {
  challengeId: string;
  contentId: number;
  contentUrl: string;
  userAddress: string;
  questions: string[];
  answers?: string[];
  contentText?: string;
};

type AIConfig = {
  ["qg-model"]: string;
  ["av-model"]: string;
  ["qg-prompt"]: string;
  ["av-prompt"]: string;
};

const configPath = path.resolve(__dirname, "..", "..", "ai-config.yml");
const config = yaml.load(readFileSync(configPath, "utf8")) as AIConfig;

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

const challenges = new Map<string, Challenge>();

/**
 * Generate a challenge: parse content, ask QG model for 3 questions, store.
 */
export async function generateChallenge(contentUrl: string, userAddress: string): Promise<Challenge> {
  const contentText = await parseContentToText(contentUrl);
  // const prompt = `${config["qg-prompt"]}\nContent:\n${contentText}`;

  const completion = await getOpenAIClient().chat.completions.create({
    model: config["qg-model"],
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: config["qg-prompt"]
      },
      {
        role: "user",
        content: `Content:\n${contentText}`
      }
    ]
  });

  const payload = completion.choices[0].message.content || "";
  let questions: string[] = [];
  console.log("payload", payload);
  try {
    const parsed = JSON.parse(payload);

    if (Array.isArray(parsed.questions)) {
      questions = parsed.questions
        .map((q: any) => {
          if (typeof q === "string") return q;
          if (typeof q?.text === "string") return q.text;
          return null;
        })
        .filter((q: string | null) => q !== null);
    }
  } catch {
    questions = [];
  }

  const challenge: Challenge = {
    challengeId: randomUUID(),
    contentId: Date.now(),
    contentUrl,
    userAddress,
    questions,
    contentText
  };

  challenges.set(challenge.challengeId, challenge);
  return challenge;
}

// Alias for typo-friendly API
export const generateChallange = generateChallenge;

/**
 * Record user answers for a given challenge.
 */
export function recordAnswers(challengeId: string, answers: string[]): void {
  const challenge = challenges.get(challengeId);
  if (!challenge) throw new Error("challenge not found");
  challenge.answers = answers;
  challenges.set(challengeId, challenge);
}

/**
 * Verify answers via AV model using stored challenge and answers; returns score.
 */
export async function verifyChallenge(challengeId: string): Promise<number> {
  const challenge = challenges.get(challengeId);
  if (!challenge) throw new Error("challenge not found");
  if (!challenge.answers) throw new Error("answers not recorded");

  // const prompt = `${config["av-prompt"]}\nContent:\n${challenge.contentText}\nQuestions: ${JSON.stringify(
  //   challenge.questions
  // )}\nAnswers: ${JSON.stringify(challenge.answers)}`;

  const completion = await getOpenAIClient().chat.completions.create({
    model: config["av-model"],
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: config["av-prompt"]
      },
      {
        role: "user",
        content:
          `Content:\n${challenge.contentText}\n` +
          `Questions:\n${JSON.stringify(challenge.questions)}\n` +
          `Answers:\n${JSON.stringify(challenge.answers)}`
      }
    ]
    
  });

  const payload = completion.choices[0].message.content || "";
  console.log("\n=== AV RAW PAYLOAD ===");
  console.log(payload);
  console.log("=== END PAYLOAD ===\n");
  let score = 0;

  try {
    const parsed = JSON.parse(payload);
  
    if (typeof parsed.score === "number") {
      score = parsed.score;
    } else if (typeof parsed.score === "string") {
      const s = Number.parseInt(parsed.score);
      if (!Number.isNaN(s)) score = s;
    } else if (parsed.result?.score) {
      const s = Number.parseInt(parsed.result.score);
      if (!Number.isNaN(s)) score = s;
    }
  } catch {
    score = 0;
  }

  return score;

}

/* ===== test-only helpers ===== */
export function __clearChallengesForTest(): void {
  challenges.clear();
}

export function __setChallengeForTest(challenge: Challenge): void {
  challenges.set(challenge.challengeId, challenge);
}

export function __getChallengeForTest(id: string): Challenge | undefined {
  return challenges.get(id);
}