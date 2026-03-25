/**
 * KAQG Question Generator
 *
 * Generates single, difficulty-calibrated questions using:
 * - Knowledge Graph context from FalkorDB
 * - Bloom's Taxonomy level targeting (mapped from IRT difficulty)
 * - Previous questions to avoid repetition
 *
 * Also grades individual answers for IRT binary scoring.
 */

import { readFileSync } from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { getOpenAIClient } from "./llm-client";
import { getConceptsByDifficulty } from "./kg-store";
import { difficultyToBloom, IRT_CORRECT_THRESHOLD } from "./irt-engine";
import { KGNode, KGEdge } from "./kg-builder";

export interface GeneratedQuestion {
  question: string;
  targetConcept: string;
  bloomLevel: string;
  difficulty: number;
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
  dimensions: GradeDimensions;
}

interface KAQGConfig {
  ["kaqg-model"]: string;
  ["kaqg-prompt"]: string;
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
const config = yaml.load(readFileSync(configPath, "utf8")) as KAQGConfig;

const MAX_DEDUP_RETRIES = 3;
const SIMILARITY_THRESHOLD = 0.55;

/**
 * Jaccard similarity on word-level bigrams.
 * Returns a value in [0, 1]; higher means more similar.
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

/**
 * Generate a single question calibrated to the target IRT difficulty.
 * Includes programmatic deduplication: if the generated question is too
 * similar to a previous one, retries with increasing temperature.
 */
export async function generateSingleQuestion(
  contentId: number,
  contentText: string,
  targetDifficulty: number,
  previousQuestions: string[]
): Promise<GeneratedQuestion> {
  const targetBloom = difficultyToBloom(targetDifficulty);

  // Retrieve relevant concepts and subgraph from FalkorDB
  const { concepts, subgraph } = await getConceptsByDifficulty(
    contentId,
    targetDifficulty
  );

  const conceptsContext = concepts.length > 0
    ? concepts.map(c => `- ${c.label} (${c.bloomLevel}, importance: ${c.importance})`).join("\n")
    : "No specific concepts available — generate from content directly.";

  const subgraphContext = formatSubgraph(subgraph.nodes, subgraph.edges);

  const previousContext = previousQuestions.length > 0
    ? previousQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
    : "None yet.";

  for (let attempt = 0; attempt <= MAX_DEDUP_RETRIES; attempt++) {
    const temperature = 0.3 + attempt * 0.25; // 0.3 → 0.55 → 0.8 → 1.05

    const completion = await getOpenAIClient().chat.completions.create({
      model: config["kaqg-model"],
      temperature,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: config["kaqg-prompt"]
        },
        {
          role: "user",
          content:
            `TARGET_BLOOM_LEVEL: ${targetBloom}\n\n` +
            `TARGET_CONCEPTS:\n${conceptsContext}\n\n` +
            `SUBGRAPH_CONTEXT:\n${subgraphContext}\n\n` +
            `PREVIOUS_QUESTIONS:\n${previousContext}\n\n` +
            `CONTENT_TEXT:\n${contentText}`
        }
      ]
    });

    const payload = completion.choices[0].message.content || "";

    let result: GeneratedQuestion;
    try {
      result = parseQuestionPayload(payload, targetDifficulty, targetBloom);
    } catch {
      // Parse failed — retry with higher temperature
      continue;
    }

    // On last attempt or if sufficiently unique, accept the question
    if (attempt === MAX_DEDUP_RETRIES || !isTooSimilar(result.question, previousQuestions)) {
      return result;
    }
  }

  throw new QuestionGenerationError("Failed to generate a unique question after all retries");
}

/**
 * Grade a single answer against the source content.
 */
export async function gradeAnswer(
  question: string,
  userAnswer: string,
  contentText: string,
  targetConcept: string
): Promise<GradeResult> {
  const MAX_GRADE_RETRIES = 2;

  for (let attempt = 0; attempt < MAX_GRADE_RETRIES; attempt++) {
    const completion = await getOpenAIClient().chat.completions.create({
      model: config["grade-model"],
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: config["grade-prompt"]
        },
        {
          role: "user",
          content:
            `QUESTION: ${question}\n\n` +
            `USER_ANSWER: ${userAnswer}\n\n` +
            `TARGET_CONCEPT: ${targetConcept}\n\n` +
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

  // Unreachable, satisfies TypeScript
  throw new GradingError("Grading failed");
}

function parseQuestionPayload(
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
      difficulty: typeof parsed.difficulty === "number" ? parsed.difficulty : fallbackDifficulty
    };
  } catch {
    throw new QuestionGenerationError("Failed to parse question response from LLM");
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

    // If the LLM provides per-dimension scores, compute total from them
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
      dimensions
    };
  } catch {
    throw new GradingError("Failed to parse grading response from LLM");
  }
}

function formatSubgraph(nodes: KGNode[], edges: KGEdge[]): string {
  if (nodes.length === 0) return "No subgraph available.";

  const nodeLines = nodes.map(n => `  [${n.id}] ${n.label} (${n.bloomLevel})`).join("\n");
  const edgeLines = edges.map(e => `  ${e.source} --[${e.relationship}]--> ${e.target}`).join("\n");

  return `Concepts:\n${nodeLines}\nRelationships:\n${edgeLines || "  None"}`;
}
