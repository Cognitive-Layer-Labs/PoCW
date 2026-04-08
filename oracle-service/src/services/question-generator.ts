/**
 * KAQG Question Generator
 *
 * Generates single, difficulty-calibrated questions using:
 * - Knowledge Graph context from FalkorDB
 * - Bloom's Taxonomy level targeting (mapped from IRT difficulty)
 * - Previous questions to avoid repetition
 *
 * Supports question types: open, mcq, true_false, scenario.
 * Also grades individual answers for IRT binary scoring.
 */

import { readFileSync } from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { getOpenAIClient } from "./llm-client";
import { getConceptsByDifficulty } from "./kg-store";
import { difficultyToBloom, IRT_CORRECT_THRESHOLD } from "./irt-engine";
import { KGNode, KGEdge } from "./kg-builder";
import { QuestionType, GenerationOpts } from "../sdk/types";

export interface GeneratedQuestion {
  question: string;
  targetConcept: string;
  bloomLevel: string;
  difficulty: number;
  type: QuestionType;
  options?: string[];       // MCQ: 4 options
  correctAnswer?: string;   // MCQ: "A"/"B"/"C"/"D", true_false: "true"/"false"
}

export interface GradeDimensions {
  accuracy: number;
  depth: number;
  specificity: number;
  reasoning: number;
}

export interface GradeResult {
  correct: boolean;
  score: number;
  reasoning: string;
  dimensions?: GradeDimensions;
}

interface AIConfig {
  ["kaqg-model"]: string;
  ["kaqg-prompt"]: string;
  ["kaqg-mcq-model"]: string;
  ["kaqg-mcq-prompt"]: string;
  ["kaqg-tf-model"]: string;
  ["kaqg-tf-prompt"]: string;
  ["kaqg-scenario-model"]: string;
  ["kaqg-scenario-prompt"]: string;
  ["grade-model"]: string;
  ["grade-prompt"]: string;
}

export class QuestionGenerationError extends Error {
  constructor(message: string) { super(message); this.name = "QuestionGenerationError"; }
}

export class GradingError extends Error {
  constructor(message: string) { super(message); this.name = "GradingError"; }
}

const configPath = path.resolve(__dirname, "..", "..", "ai-config.yml");
const config = yaml.load(readFileSync(configPath, "utf8")) as AIConfig;

const MAX_DEDUP_RETRIES = 3;
const SIMILARITY_THRESHOLD = 0.55;

/**
 * Jaccard similarity on word-level bigrams.
 */
function questionSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const bigrams = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.add(`${words[i]} ${words[i + 1]}`);
    }
    return bigrams;
  };
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const bg of sa) {
    if (sb.has(bg)) intersection++;
  }
  return intersection / (sa.size + sb.size - intersection);
}

function isTooSimilar(newQuestion: string, previousQuestions: string[]): boolean {
  return previousQuestions.some(q => questionSimilarity(newQuestion, q) > SIMILARITY_THRESHOLD);
}

function formatSubgraph(nodes: KGNode[], edges: KGEdge[]): string {
  if (nodes.length === 0) return "No subgraph available.";
  const nodeLines = nodes.map(n => `  [${n.id}] ${n.label} (${n.bloomLevel})`).join("\n");
  const edgeLines = edges.map(e => `  ${e.source} --[${e.relationship}]--> ${e.target}`).join("\n");
  return `Concepts:\n${nodeLines}\nRelationships:\n${edgeLines || "  None"}`;
}

/** Build the system prompt with optional persona injection */
function buildSystemPrompt(basePrompt: string, opts?: GenerationOpts): string {
  if (opts?.persona) {
    return `${basePrompt}\n\nPERSONA: Frame all questions as if ${opts.persona}. Adjust vocabulary and complexity to match this perspective.`;
  }
  return basePrompt;
}

/** Build the user message with concepts, subgraph, previous questions, content, and language */
function buildUserMessage(
  targetBloom: string,
  conceptsContext: string,
  subgraphContext: string,
  previousContext: string,
  contentText: string,
  opts?: GenerationOpts
): string {
  let msg =
    `TARGET_BLOOM_LEVEL: ${targetBloom}\n\n` +
    `TARGET_CONCEPTS:\n${conceptsContext}\n\n` +
    `SUBGRAPH_CONTEXT:\n${subgraphContext}\n\n` +
    `PREVIOUS_QUESTIONS:\n${previousContext}\n\n`;

  if (opts?.language) {
    msg += `LANGUAGE: Generate the question in ${opts.language}.\n\n`;
  } else {
    msg += `LANGUAGE: Generate the question in the same language as the content.\n\n`;
  }

  msg += `CONTENT_TEXT:\n${contentText}`;
  return msg;
}

/** Resolve which LLM model to use */
function resolveModel(configKey: string, opts?: GenerationOpts): string {
  return opts?.model || (config as any)[configKey];
}

// ─── Shared context builder ──────────────────────────────────────────────────

async function buildContext(contentId: number, targetDifficulty: number, previousQuestions: string[]) {
  const targetBloom = difficultyToBloom(targetDifficulty);
  const { concepts, subgraph } = await getConceptsByDifficulty(contentId, targetDifficulty);

  const conceptsContext = concepts.length > 0
    ? concepts.map(c => `- ${c.label} (${c.bloomLevel}, importance: ${c.importance})`).join("\n")
    : "No specific concepts available — generate from content directly.";

  const subgraphContext = formatSubgraph(subgraph.nodes, subgraph.edges);

  const previousContext = previousQuestions.length > 0
    ? previousQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
    : "None yet.";

  return { targetBloom, conceptsContext, subgraphContext, previousContext };
}

// ─── Open-ended question generation ──────────────────────────────────────────

/**
 * Generate a single open-ended question calibrated to the target IRT difficulty.
 */
export async function generateSingleQuestion(
  contentId: number,
  contentText: string,
  targetDifficulty: number,
  previousQuestions: string[],
  opts?: GenerationOpts
): Promise<GeneratedQuestion> {
  const { targetBloom, conceptsContext, subgraphContext, previousContext } =
    await buildContext(contentId, targetDifficulty, previousQuestions);

  for (let attempt = 0; attempt <= MAX_DEDUP_RETRIES; attempt++) {
    const temperature = 0.3 + attempt * 0.25;

    const completion = await getOpenAIClient().chat.completions.create({
      model: resolveModel("kaqg-model", opts),
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(config["kaqg-prompt"], opts) },
        { role: "user", content: buildUserMessage(targetBloom, conceptsContext, subgraphContext, previousContext, contentText, opts) }
      ]
    });

    const payload = completion.choices[0].message.content || "";
    let result: GeneratedQuestion;
    try {
      result = parseOpenPayload(payload, targetDifficulty, targetBloom);
    } catch {
      continue;
    }

    if (attempt === MAX_DEDUP_RETRIES || !isTooSimilar(result.question, previousQuestions)) {
      return result;
    }
  }

  throw new QuestionGenerationError("Failed to generate a unique question after all retries");
}

// ─── MCQ generation ──────────────────────────────────────────────────────────

export async function generateMCQ(
  contentId: number,
  contentText: string,
  targetDifficulty: number,
  previousQuestions: string[],
  opts?: GenerationOpts
): Promise<GeneratedQuestion> {
  const { targetBloom, conceptsContext, subgraphContext, previousContext } =
    await buildContext(contentId, targetDifficulty, previousQuestions);

  for (let attempt = 0; attempt <= MAX_DEDUP_RETRIES; attempt++) {
    const temperature = 0.3 + attempt * 0.25;

    const completion = await getOpenAIClient().chat.completions.create({
      model: resolveModel("kaqg-mcq-model", opts),
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(config["kaqg-mcq-prompt"], opts) },
        { role: "user", content: buildUserMessage(targetBloom, conceptsContext, subgraphContext, previousContext, contentText, opts) }
      ]
    });

    const payload = completion.choices[0].message.content || "";
    let result: GeneratedQuestion;
    try {
      result = parseMCQPayload(payload, targetDifficulty, targetBloom);
    } catch {
      continue;
    }

    if (attempt === MAX_DEDUP_RETRIES || !isTooSimilar(result.question, previousQuestions)) {
      return result;
    }
  }

  throw new QuestionGenerationError("Failed to generate a unique MCQ after all retries");
}

// ─── True/False generation ───────────────────────────────────────────────────

export async function generateTrueFalse(
  contentId: number,
  contentText: string,
  targetDifficulty: number,
  previousQuestions: string[],
  opts?: GenerationOpts
): Promise<GeneratedQuestion> {
  const { targetBloom, conceptsContext, subgraphContext, previousContext } =
    await buildContext(contentId, targetDifficulty, previousQuestions);

  for (let attempt = 0; attempt <= MAX_DEDUP_RETRIES; attempt++) {
    const temperature = 0.3 + attempt * 0.25;

    const completion = await getOpenAIClient().chat.completions.create({
      model: resolveModel("kaqg-tf-model", opts),
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(config["kaqg-tf-prompt"], opts) },
        { role: "user", content: buildUserMessage(targetBloom, conceptsContext, subgraphContext, previousContext, contentText, opts) }
      ]
    });

    const payload = completion.choices[0].message.content || "";
    let result: GeneratedQuestion;
    try {
      result = parseTFPayload(payload, targetDifficulty, targetBloom);
    } catch {
      continue;
    }

    if (attempt === MAX_DEDUP_RETRIES || !isTooSimilar(result.question, previousQuestions)) {
      return result;
    }
  }

  throw new QuestionGenerationError("Failed to generate a unique true/false statement after all retries");
}

// ─── Scenario generation ─────────────────────────────────────────────────────

export async function generateScenario(
  contentId: number,
  contentText: string,
  targetDifficulty: number,
  previousQuestions: string[],
  opts?: GenerationOpts
): Promise<GeneratedQuestion> {
  const { targetBloom, conceptsContext, subgraphContext, previousContext } =
    await buildContext(contentId, targetDifficulty, previousQuestions);

  for (let attempt = 0; attempt <= MAX_DEDUP_RETRIES; attempt++) {
    const temperature = 0.3 + attempt * 0.25;

    const completion = await getOpenAIClient().chat.completions.create({
      model: resolveModel("kaqg-scenario-model", opts),
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(config["kaqg-scenario-prompt"], opts) },
        { role: "user", content: buildUserMessage(targetBloom, conceptsContext, subgraphContext, previousContext, contentText, opts) }
      ]
    });

    const payload = completion.choices[0].message.content || "";
    let result: GeneratedQuestion;
    try {
      result = parseOpenPayload(payload, targetDifficulty, targetBloom);
      result.type = "scenario";
    } catch {
      continue;
    }

    if (attempt === MAX_DEDUP_RETRIES || !isTooSimilar(result.question, previousQuestions)) {
      return result;
    }
  }

  throw new QuestionGenerationError("Failed to generate a unique scenario question after all retries");
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Generate a question of the specified type.
 */
export async function generateQuestion(
  contentId: number,
  contentText: string,
  targetDifficulty: number,
  previousQuestions: string[],
  qType: QuestionType = "open",
  opts?: GenerationOpts
): Promise<GeneratedQuestion> {
  switch (qType) {
    case "mcq":
      return generateMCQ(contentId, contentText, targetDifficulty, previousQuestions, opts);
    case "true_false":
      return generateTrueFalse(contentId, contentText, targetDifficulty, previousQuestions, opts);
    case "scenario":
      return generateScenario(contentId, contentText, targetDifficulty, previousQuestions, opts);
    case "open":
    default:
      return generateSingleQuestion(contentId, contentText, targetDifficulty, previousQuestions, opts);
  }
}

// ─── Grading ─────────────────────────────────────────────────────────────────

/**
 * Grade an open-ended or scenario answer using LLM (4-dimension scoring).
 */
export async function gradeAnswer(
  question: string,
  userAnswer: string,
  contentText: string,
  targetConcept: string,
  opts?: GenerationOpts
): Promise<GradeResult> {
  const MAX_GRADE_RETRIES = 2;

  let langLine = "";
  if (opts?.language) {
    langLine = `\nLANGUAGE: Grade the answer in ${opts.language}.\n`;
  }

  for (let attempt = 0; attempt < MAX_GRADE_RETRIES; attempt++) {
    const completion = await getOpenAIClient().chat.completions.create({
      model: resolveModel("grade-model", opts),
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: config["grade-prompt"] },
        {
          role: "user",
          content:
            `QUESTION: ${question}\n\n` +
            `USER_ANSWER: ${userAnswer}\n\n` +
            `TARGET_CONCEPT: ${targetConcept}\n${langLine}\n` +
            `SOURCE_TEXT:\n${contentText}`
        }
      ]
    });

    const payload = completion.choices[0].message.content || "";
    try {
      return parseGradePayload(payload);
    } catch {
      if (attempt === MAX_GRADE_RETRIES - 1) {
        throw new GradingError("Failed to parse grading response after retries");
      }
    }
  }

  throw new GradingError("Grading failed");
}

/**
 * Grade an MCQ or True/False answer. No LLM call needed — exact match.
 */
export function gradeMCQOrTF(
  userAnswer: string,
  correctAnswer: string,
  questionType: "mcq" | "true_false"
): GradeResult {
  const normalized = userAnswer.trim().toLowerCase();
  const expected = correctAnswer.trim().toLowerCase();

  let correct: boolean;
  if (questionType === "mcq") {
    // Accept "A", "a", "Option A", etc.
    correct = normalized === expected || normalized.startsWith(expected);
  } else {
    // Accept "true", "false", "t", "f"
    correct = normalized === expected
      || (expected === "true" && (normalized === "t" || normalized === "yes"))
      || (expected === "false" && (normalized === "f" || normalized === "no"));
  }

  const score = correct ? 100 : 0;
  return {
    correct,
    score,
    reasoning: correct ? "Correct answer selected." : `Incorrect. The correct answer was: ${correctAnswer}`,
  };
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseOpenPayload(
  payload: string,
  fallbackDifficulty: number,
  fallbackBloom: string
): GeneratedQuestion {
  try {
    const parsed = JSON.parse(payload);
    return {
      question: String(parsed.question || "Unable to generate question"),
      targetConcept: String(parsed.targetConcept || "unknown"),
      bloomLevel: parsed.bloomLevel || fallbackBloom,
      difficulty: typeof parsed.difficulty === "number" ? parsed.difficulty : fallbackDifficulty,
      type: "open",
    };
  } catch {
    throw new QuestionGenerationError("Failed to parse question response from LLM");
  }
}

function parseMCQPayload(
  payload: string,
  fallbackDifficulty: number,
  fallbackBloom: string
): GeneratedQuestion {
  try {
    const parsed = JSON.parse(payload);
    const options = Array.isArray(parsed.options) ? parsed.options.map(String) : [];
    if (options.length !== 4) throw new Error("MCQ must have exactly 4 options");
    const correctAnswer = String(parsed.correctAnswer || "A").toUpperCase();
    if (!["A", "B", "C", "D"].includes(correctAnswer)) throw new Error("Invalid correctAnswer");
    return {
      question: String(parsed.question || ""),
      targetConcept: String(parsed.targetConcept || "unknown"),
      bloomLevel: parsed.bloomLevel || fallbackBloom,
      difficulty: typeof parsed.difficulty === "number" ? parsed.difficulty : fallbackDifficulty,
      type: "mcq",
      options,
      correctAnswer,
    };
  } catch {
    throw new QuestionGenerationError("Failed to parse MCQ response from LLM");
  }
}

function parseTFPayload(
  payload: string,
  fallbackDifficulty: number,
  fallbackBloom: string
): GeneratedQuestion {
  try {
    const parsed = JSON.parse(payload);
    const correctAnswer = typeof parsed.correctAnswer === "boolean"
      ? String(parsed.correctAnswer)
      : String(parsed.correctAnswer || "true").toLowerCase();
    return {
      question: String(parsed.statement || parsed.question || ""),
      targetConcept: String(parsed.targetConcept || "unknown"),
      bloomLevel: parsed.bloomLevel || fallbackBloom,
      difficulty: typeof parsed.difficulty === "number" ? parsed.difficulty : fallbackDifficulty,
      type: "true_false",
      correctAnswer,
    };
  } catch {
    throw new QuestionGenerationError("Failed to parse true/false response from LLM");
  }
}

function clampDim(v: unknown): number {
  return Math.max(0, Math.min(25, Number(v) || 0));
}

function parseGradePayload(payload: string): GradeResult {
  try {
    const parsed = JSON.parse(payload);

    const dimensions: GradeDimensions = {
      accuracy: clampDim(parsed.accuracy),
      depth: clampDim(parsed.depth),
      specificity: clampDim(parsed.specificity),
      reasoning: clampDim(parsed.reasoning_score)
    };

    const dimSum = dimensions.accuracy + dimensions.depth + dimensions.specificity + dimensions.reasoning;
    const score = dimSum > 0
      ? Math.max(0, Math.min(100, dimSum))
      : Math.max(0, Math.min(100, Number(parsed.score) || 0));

    return {
      score,
      correct: typeof parsed.correct === "boolean"
        ? parsed.correct
        : score >= IRT_CORRECT_THRESHOLD,
      reasoning: String(parsed.reasoning || "No reasoning provided"),
      dimensions,
    };
  } catch {
    throw new GradingError("Failed to parse grading response from LLM");
  }
}
