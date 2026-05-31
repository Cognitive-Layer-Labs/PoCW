/**
 * Question Generation Agent (KAQG)
 *
 * Generates difficulty-calibrated questions using:
 *  - KG concepts from FalkorDB (filtered by Bloom level)
 *  - Content chunks as source material
 *  - Previous questions for deduplication
 *
 * Inputs per generation call:
 *   contentId     — used to query KG for the right concept subgraph
 *   contentText   — source material chunk
 *   targetDifficulty — IRT b value selected by KAQG-CAT
 *   previousQuestions — all questions already asked (dedup)
 *   qType         — open | mcq | true_false | scenario
 *   opts          — language, persona, model overrides
 *
 * Output: GeneratedQuestion with question text, bloomLevel, difficulty,
 *         targetConcept, and (for MCQ/TF) options + correctAnswer.
 */

import { readFileSync } from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { callLLM } from "./llm-client";
import { getConceptsByDifficulty, getConceptWithEdges } from "./kg-store";
import { difficultyToBloom } from "./irt-engine";
import { KGNode, KGEdge } from "./kg-builder";
import { QuestionType, GenerationOpts } from "../sdk/types";

// Canonical definition — question-generator.ts re-exports this for backward compat.
export interface GeneratedQuestion {
  question: string;
  targetConcept: string;
  bloomLevel: string;
  difficulty: number;
  type: QuestionType;
  options?: string[];
  correctAnswer?: string;
  /** Key points a correct open answer must cover (for claim-based grading). */
  referenceKeyPoints?: string[];
  /** Pre-formatted concept label + edge context passed to the grader. */
  conceptContext?: string;
}

interface AIConfig {
  ["kaqg-model"]: string;
  ["kaqg-prompt"]: string;
  ["kaqg-mcq-model"]: string;
  ["kaqg-mcq-prompt"]: string;
  ["kaqg-tf-model"]: string;
  ["kaqg-tf-prompt"]: string;
}

const configPath = path.resolve(__dirname, "..", "..", "ai-config.yml");
const aiConfig = yaml.load(readFileSync(configPath, "utf8")) as AIConfig;

const MAX_RETRIES = 3;
const JACCARD_THRESHOLD = 0.45;
const LEVENSHTEIN_RATIO_THRESHOLD = 0.80;

// ─── Text similarity helpers ─────────────────────────────────────────────────

function normalizeText(s: string): string {
  const stopwords = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can", "need", "dare", "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "through", "during", "before", "after", "above", "below", "between", "out", "off", "over", "under", "again", "further", "then", "once", "here", "there", "when", "where", "why", "how", "all", "both", "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "just", "because", "but", "and", "or", "if", "while", "that", "this", "these", "those", "it", "its", "what", "which", "who", "whom", "about"]);
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim()
    .split(" ").filter(w => w && !stopwords.has(w)).join(" ");
}

function jaccardBigram(a: string, b: string): number {
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const sa = bigrams(a), sb = bigrams(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const bg of sa) { if (sb.has(bg)) intersection++; }
  return intersection / (sa.size + sb.size - intersection);
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] / Math.max(m, n);
}

function isTooSimilar(newQ: string, previous: string[]): boolean {
  const norm = normalizeText(newQ);
  return previous.some(q => {
    const nq = normalizeText(q);
    return jaccardBigram(norm, nq) > JACCARD_THRESHOLD || levenshteinRatio(norm, nq) > LEVENSHTEIN_RATIO_THRESHOLD;
  });
}

// ─── Context builders ────────────────────────────────────────────────────────

function formatSubgraph(nodes: KGNode[], edges: KGEdge[]): string {
  if (!nodes.length) return "No subgraph available.";
  const nodeLines = nodes.map(n => `  [${n.id}] ${n.label} (${n.bloomLevel})`).join("\n");
  const edgeLines = edges.map(e => `  ${e.source} --[${e.relationship}]--> ${e.target}`).join("\n");
  return `Concepts:\n${nodeLines}\nRelationships:\n${edgeLines || "  None"}`;
}

function buildSystemPrompt(base: string, opts?: GenerationOpts): string {
  if (opts?.persona) {
    return `${base}\n\nPERSONA: Frame all questions as if ${opts.persona}. Adjust vocabulary and complexity to match this perspective.`;
  }
  return base;
}

function buildUserMessage(
  targetBloom: string, conceptsCtx: string, subgraphCtx: string, prevCtx: string,
  content: string, opts?: GenerationOpts, edgeDirection?: 'direct' | 'incoming' | 'outgoing'
): string {
  let msg = `TARGET_BLOOM_LEVEL: ${targetBloom}\n\nTARGET_CONCEPTS:\n${conceptsCtx}\n\nSUBGRAPH_CONTEXT:\n${subgraphCtx}\n\nPREVIOUS_QUESTIONS:\n${prevCtx}\n\n`;
  if (edgeDirection === 'incoming') {
    msg += `EDGE_FOCUS: This is a re-ask. Focus on what LEADS TO or DEFINES this concept — its preconditions, causes, and context.\n\n`;
  } else if (edgeDirection === 'outgoing') {
    msg += `EDGE_FOCUS: This is a re-ask. Focus on what this concept ENABLES, PRODUCES, or CAUSES — its consequences and applications.\n\n`;
  }
  msg += opts?.language
    ? `LANGUAGE: Generate the question in ${opts.language}.\n\n`
    : `LANGUAGE: Generate the question in the same language as the content.\n\n`;
  msg += `CONTENT_TEXT:\n${content}`;
  return msg;
}

function buildUserMessageWithFeedback(
  targetBloom: string, conceptsCtx: string, subgraphCtx: string, prevCtx: string,
  content: string, feedback: string, opts?: GenerationOpts, edgeDirection?: 'direct' | 'incoming' | 'outgoing'
): string {
  const base = buildUserMessage(targetBloom, conceptsCtx, subgraphCtx, prevCtx, content, opts, edgeDirection);
  return `${base}\n\nEVALUATOR_FEEDBACK (previous attempt was rejected — address these issues):\n${feedback}`;
}

function resolveModel(configKey: string, opts?: GenerationOpts): string {
  return opts?.model || (aiConfig as any)[configKey];
}

async function buildContext(
  contentId: number,
  targetDifficulty: number,
  previousQuestions: string[],
  targetConceptId?: string,
  edgeDirection?: 'direct' | 'incoming' | 'outgoing'
) {
  const targetBloom = difficultyToBloom(targetDifficulty);

  let conceptsCtx: string;
  let subgraphCtx: string;
  let conceptContext: string | undefined;
  let degraded = false;

  if (targetConceptId) {
    const dir = edgeDirection ?? 'direct';
    const { concept, edges, neighborNodes } = await getConceptWithEdges(contentId, targetConceptId, dir);
    if (concept) {
      conceptsCtx = `- ${concept.label} (${concept.bloomLevel}, importance: ${concept.importance})`;
      const allNodes = [concept, ...neighborNodes];
      subgraphCtx = formatSubgraph(allNodes, edges);
      const edgeLines = edges.map(e => {
        const srcLabel = allNodes.find(n => n.id === e.source)?.label ?? e.source;
        const tgtLabel = allNodes.find(n => n.id === e.target)?.label ?? e.target;
        return `${srcLabel} --[${e.relationship}]--> ${tgtLabel}`;
      });
      conceptContext = `Concept: ${concept.label}\nRelationships:\n${edgeLines.join("\n") || "  None"}`;
    } else {
      // Concept not found — fall back to Bloom-based lookup
      const result = await getConceptsByDifficulty(contentId, targetDifficulty);
      degraded = result.degraded ?? false;
      conceptsCtx = result.concepts.map(c => `- ${c.label} (${c.bloomLevel}, importance: ${c.importance})`).join("\n")
        || "No specific concepts available — generate from content directly.";
      subgraphCtx = formatSubgraph(result.subgraph.nodes, result.subgraph.edges);
    }
  } else {
    const result = await getConceptsByDifficulty(contentId, targetDifficulty);
    degraded = result.degraded ?? false;
    if (degraded) console.warn("[question-generation-agent] FalkorDB unavailable — generating without KG context");
    conceptsCtx = result.concepts.length > 0
      ? result.concepts.map(c => `- ${c.label} (${c.bloomLevel}, importance: ${c.importance})`).join("\n")
      : "No specific concepts available — generate from content directly.";
    subgraphCtx = formatSubgraph(result.subgraph.nodes, result.subgraph.edges);
  }

  const prevCtx = previousQuestions.length > 0
    ? previousQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
    : "None yet.";

  return { targetBloom, conceptsCtx, subgraphCtx, prevCtx, conceptContext, degraded };
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseOpenPayload(payload: string, fallbackDiff: number, fallbackBloom: string): GeneratedQuestion {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Truncated JSON fallback — extract fields via regex when LLM cuts off mid-array
    const qMatch = payload.match(/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!qMatch) throw new Error("Could not extract question from truncated LLM response");
    const conceptMatch = payload.match(/"targetConcept"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const bloomMatch   = payload.match(/"bloomLevel"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const diffMatch    = payload.match(/"difficulty"\s*:\s*([-\d.]+)/);
    const kpSection    = payload.match(/"referenceKeyPoints"\s*:\s*\[(.*)/s)?.[1] ?? "";
    const kpItems      = [...kpSection.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).filter(Boolean);
    parsed = {
      question:          qMatch[1],
      targetConcept:     conceptMatch?.[1] ?? "unknown",
      bloomLevel:        bloomMatch?.[1] ?? fallbackBloom,
      difficulty:        diffMatch ? parseFloat(diffMatch[1]) : fallbackDiff,
      referenceKeyPoints: kpItems.length > 0 ? kpItems : undefined,
    };
  }
  const referenceKeyPoints = Array.isArray(parsed.referenceKeyPoints)
    ? (parsed.referenceKeyPoints as unknown[]).map(String).filter(Boolean)
    : undefined;
  return {
    question: String(parsed.question || ""),
    targetConcept: String(parsed.targetConcept || "unknown"),
    bloomLevel: (parsed.bloomLevel as string) || fallbackBloom,
    difficulty: typeof parsed.difficulty === "number" ? parsed.difficulty : fallbackDiff,
    type: "open",
    referenceKeyPoints,
  };
}

function parseMCQPayload(payload: string, fallbackDiff: number, fallbackBloom: string): GeneratedQuestion {
  const parsed = JSON.parse(payload);
  const stripPrefix = (s: string) => s.replace(/^[A-Da-d][\.\)]\s*/, "").trim();
  const options = Array.isArray(parsed.options) ? parsed.options.map((s: unknown) => stripPrefix(String(s))) : [];
  if (options.length !== 4) throw new Error("MCQ must have exactly 4 options");
  const correctAnswer = String(parsed.correctAnswer || "A").toUpperCase();
  if (!["A", "B", "C", "D"].includes(correctAnswer)) throw new Error("Invalid correctAnswer");
  return {
    question: String(parsed.question || ""),
    targetConcept: String(parsed.targetConcept || "unknown"),
    bloomLevel: parsed.bloomLevel || fallbackBloom,
    difficulty: typeof parsed.difficulty === "number" ? parsed.difficulty : fallbackDiff,
    type: "mcq",
    options,
    correctAnswer,
  };
}

function parseTFPayload(payload: string, fallbackDiff: number, fallbackBloom: string): GeneratedQuestion {
  const parsed = JSON.parse(payload);
  const correctAnswer = typeof parsed.correctAnswer === "boolean"
    ? String(parsed.correctAnswer)
    : String(parsed.correctAnswer || "true").toLowerCase();
  return {
    question: String(parsed.statement || parsed.question || ""),
    targetConcept: String(parsed.targetConcept || "unknown"),
    bloomLevel: parsed.bloomLevel || fallbackBloom,
    difficulty: typeof parsed.difficulty === "number" ? parsed.difficulty : fallbackDiff,
    type: "true_false",
    correctAnswer,
  };
}

// ─── Question format validation ───────────────────────────────────────────────

function validateFormat(q: GeneratedQuestion, degraded: boolean): { ok: boolean; reason?: string } {
  if (q.question.length < 15 || q.question.length > 800) {
    return { ok: false, reason: `Question length ${q.question.length} outside 15-800 range` };
  }
  if (q.type === "open" && !q.question.includes("?") && !q.question.trim().endsWith(":")) {
    return { ok: false, reason: "Open question must contain '?' or end with ':'" };
  }
  if (q.type === "mcq") {
    if (!q.options || q.options.length !== 4) return { ok: false, reason: "MCQ must have exactly 4 options" };
    if (q.options.some(o => !o.trim())) return { ok: false, reason: "MCQ option must not be empty" };
    if (new Set(q.options.map(o => o.trim().toLowerCase())).size !== 4) return { ok: false, reason: "MCQ has duplicate options" };
  }
  if (q.type === "true_false" && q.correctAnswer !== "true" && q.correctAnswer !== "false") {
    return { ok: false, reason: `True/False correctAnswer must be "true" or "false"` };
  }
  if (!q.targetConcept || q.targetConcept === "unknown") {
    if (!degraded) return { ok: false, reason: "targetConcept is empty or unknown" };
  }
  return { ok: true };
}

// ─── QuestionGenerationAgent ─────────────────────────────────────────────────

export interface GenerationParams {
  contentId: number;
  contentText: string;
  targetDifficulty: number;
  previousQuestions: string[];
  qType: QuestionType;
  opts?: GenerationOpts;
  evaluatorFeedback?: string;
  /** If set, generation focuses on this specific KG concept. */
  targetConceptId?: string;
  /** Edge direction for re-ask questions. */
  edgeDirection?: 'direct' | 'incoming' | 'outgoing';
}

export class QuestionGenerationError extends Error {
  constructor(message: string) { super(message); this.name = "QuestionGenerationError"; }
}

export class QuestionGenerationAgent {

  /**
   * Generate a single question of the specified type.
   * Handles context building, LLM call, parsing, and format validation.
   * Dedup is checked against previousQuestions via Jaccard + Levenshtein.
   *
   * If evaluatorFeedback is provided (from a failed evaluation attempt),
   * it is appended to the user message to guide regeneration.
   */
  async generate(params: GenerationParams): Promise<GeneratedQuestion> {
    const { contentId, contentText, targetDifficulty, previousQuestions, qType, opts, evaluatorFeedback, targetConceptId, edgeDirection } = params;

    const ctx = await buildContext(contentId, targetDifficulty, previousQuestions, targetConceptId, edgeDirection);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const temperature = 0.3 + attempt * 0.25;

      const userMsg = evaluatorFeedback && attempt === 0
        ? buildUserMessageWithFeedback(ctx.targetBloom, ctx.conceptsCtx, ctx.subgraphCtx, ctx.prevCtx, contentText, evaluatorFeedback, opts, edgeDirection)
        : buildUserMessage(ctx.targetBloom, ctx.conceptsCtx, ctx.subgraphCtx, ctx.prevCtx, contentText, opts, edgeDirection);

      let result: GeneratedQuestion;
      try {
        result = await this._callLLM(qType, userMsg, targetDifficulty, ctx.targetBloom, temperature, opts);
      } catch (err) {
        console.warn(`[question-generation-agent] attempt ${attempt}/${MAX_RETRIES} failed:`, err);
        continue;
      }

      const validation = validateFormat(result, ctx.degraded);
      if (!validation.ok) {
        console.warn(`[question-generation-agent] Format validation failed: ${validation.reason}`);
        if (attempt === MAX_RETRIES) return result;
        continue;
      }

      if (attempt === MAX_RETRIES || !isTooSimilar(result.question, previousQuestions)) {
        // Attach concept context for the grader
        if (ctx.conceptContext) result.conceptContext = ctx.conceptContext;
        return result;
      }
    }

    throw new QuestionGenerationError(`Failed to generate a unique ${qType} question after ${MAX_RETRIES} retries`);
  }

  private async _callLLM(
    qType: QuestionType,
    userMsg: string,
    fallbackDiff: number,
    fallbackBloom: string,
    temperature: number,
    opts?: GenerationOpts
  ): Promise<GeneratedQuestion> {
    let modelKey: string;
    let promptKey: string;

    switch (qType) {
      case "mcq":        modelKey = "kaqg-mcq-model"; promptKey = "kaqg-mcq-prompt"; break;
      case "true_false": modelKey = "kaqg-tf-model";  promptKey = "kaqg-tf-prompt";  break;
      default:           modelKey = "kaqg-model";      promptKey = "kaqg-prompt";
    }

    const completion = await callLLM(c => c.chat.completions.create({
      model: resolveModel(modelKey, opts),
      temperature,
      max_tokens: qType === "open" ? 1024 : undefined,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt((aiConfig as any)[promptKey], opts) },
        { role: "user", content: userMsg },
      ],
    }));

    const payload = completion.choices[0].message.content || "";

    switch (qType) {
      case "mcq":        return parseMCQPayload(payload, fallbackDiff, fallbackBloom);
      case "true_false": return parseTFPayload(payload, fallbackDiff, fallbackBloom);
      default:           return parseOpenPayload(payload, fallbackDiff, fallbackBloom);
    }
  }
}
