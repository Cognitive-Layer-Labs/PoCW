/**
 * KAQG Orchestrator — Generate-Evaluate Loop
 *
 * Coordinates the two KAQG agents:
 *   1. QuestionGenerationAgent — generates a question from KG + content + Bloom target
 *   2. QuestionEvaluationAgent — verifies quality; grades user answers
 *
 * Public API is unchanged: generateQuestion(), gradeAnswer(), gradeMCQOrTF().
 * verify-session.ts and tests use these functions directly.
 *
 * The generate-evaluate loop (matching the KAQG paper diagram):
 *
 *   Generation Agent ──► Evaluation Agent ──► pass? ──► return to CAT session
 *         ▲                                        │
 *         └──────────── retry with feedback ───────┘ (max 2 eval retries)
 *
 * (The LLM Evaluation Agent only runs when question-eval-model is set.) Then the question check
 * (question-check.ts, decisions model): if it flags the question, it is regenerated ONCE with the
 * check's feedback; a failed check or a failed regeneration keeps the original question.
 */

import { QuestionType, GenerationOpts } from "../sdk/types";
import { QuestionGenerationAgent, QuestionGenerationError, GeneratedQuestion } from "./question-generation-agent";
import { QuestionEvaluationAgent, GradeResult } from "./question-evaluation-agent";
import { bloomTargetFor } from "./irt-engine";
import { checkQuestion } from "./question-check";

// ─── Re-export types so callers don't need to change imports ─────────────────

export type { GeneratedQuestion } from "./question-generation-agent";
export type { GradeResult, GradeDimensions } from "./question-evaluation-agent";
export { QuestionGenerationError } from "./question-generation-agent";
export { GradingError } from "./question-evaluation-agent";

// ─── Singletons ───────────────────────────────────────────────────────────────

const generationAgent = new QuestionGenerationAgent();
const evaluationAgent = new QuestionEvaluationAgent();

const MAX_EVAL_RETRIES = 2;

// ─── Generate-evaluate loop ───────────────────────────────────────────────────

/**
 * Generate a single question and check it before it is shown.
 *
 *   1. generateEvaluated(): Generation Agent (+ the optional LLM Evaluation Agent loop).
 *   2. Question check (decisions model, question-check.ts). If it flags the question (wrong MCQ
 *      key, not answerable from the passage, not plainly worded), regenerate ONCE with its
 *      feedback and use the result unchecked. A failed check or regeneration keeps the original.
 */
export async function generateQuestion(
  contentId: number,
  contentText: string,
  targetDifficulty: number,
  previousQuestions: string[],
  qType: QuestionType = "open",
  opts?: GenerationOpts,
  targetConceptId?: string,
  edgeDirection?: 'direct' | 'incoming' | 'outgoing'
): Promise<GeneratedQuestion> {
  const question = await generateEvaluated(
    contentId, contentText, targetDifficulty, previousQuestions, qType, opts, targetConceptId, edgeDirection,
  );

  const check = await checkQuestion(question, contentText);
  if (check.status !== "regenerate") return question;
  try {
    return await generationAgent.generate({
      contentId,
      contentText,
      targetDifficulty,
      previousQuestions: [...previousQuestions, question.question],
      qType,
      opts,
      evaluatorFeedback: check.feedback,
      targetConceptId,
      edgeDirection,
    });
  } catch (err) {
    console.warn(`[question-generator] regeneration after the question check failed, keeping the original: ${err instanceof Error ? err.message : err}`);
    return question;
  }
}

/**
 * Generation + optional LLM quality evaluation (only when question-eval-model is set):
 *   1. Generation Agent produces a question at targetDifficulty / targetBloom.
 *   2. Evaluation Agent checks quality (answerability, Bloom match, MCQ distractors).
 *   3. Pass → return; fail → retry with the evaluator's feedback (max 2 eval retries, then accept).
 */
async function generateEvaluated(
  contentId: number,
  contentText: string,
  targetDifficulty: number,
  previousQuestions: string[],
  qType: QuestionType,
  opts: GenerationOpts | undefined,
  targetConceptId: string | undefined,
  edgeDirection: 'direct' | 'incoming' | 'outgoing' | undefined,
): Promise<GeneratedQuestion> {
  const targetBloom = bloomTargetFor(targetDifficulty);
  let evaluatorFeedback: string | undefined;

  for (let evalAttempt = 0; evalAttempt <= MAX_EVAL_RETRIES; evalAttempt++) {
    const question = await generationAgent.generate({
      contentId,
      contentText,
      targetDifficulty,
      previousQuestions,
      qType,
      opts,
      evaluatorFeedback,
      targetConceptId,
      edgeDirection,
    });

    // On the last eval attempt, skip the quality check and accept the question.
    if (evalAttempt === MAX_EVAL_RETRIES) {
      return question;
    }

    const evalResult = await evaluationAgent.evaluateQuestion(
      question,
      contentText,
      targetBloom,
      opts
    );

    if (evalResult.pass) {
      return question;
    }

    // Pass feedback to the next generation attempt.
    evaluatorFeedback = evalResult.feedback;
    console.warn(`[question-generator] Eval retry ${evalAttempt + 1}: ${evalResult.feedback}`);
  }

  // Unreachable but TypeScript needs it.
  throw new QuestionGenerationError("generateQuestion: unexpected exit from loop");
}

// ─── Per-type wrappers (backward compat for tests and direct callers) ────────

export const generateSingleQuestion = (
  contentId: number, contentText: string, targetDifficulty: number,
  previousQuestions: string[], opts?: GenerationOpts
): Promise<GeneratedQuestion> =>
  generateQuestion(contentId, contentText, targetDifficulty, previousQuestions, "open", opts);

export const generateMCQ = (
  contentId: number, contentText: string, targetDifficulty: number,
  previousQuestions: string[], opts?: GenerationOpts
): Promise<GeneratedQuestion> =>
  generateQuestion(contentId, contentText, targetDifficulty, previousQuestions, "mcq", opts);

export const generateTrueFalse = (
  contentId: number, contentText: string, targetDifficulty: number,
  previousQuestions: string[], opts?: GenerationOpts
): Promise<GeneratedQuestion> =>
  generateQuestion(contentId, contentText, targetDifficulty, previousQuestions, "true_false", opts);


// ─── Grading (delegated to Evaluation Agent) ─────────────────────────────────

/**
 * Grade an open-ended or scenario answer using LLM (4-dimension scoring).
 */
export async function gradeAnswer(
  question: string,
  userAnswer: string,
  contentText: string,
  targetConcept: string,
  opts?: GenerationOpts,
  referenceKeyPoints?: string[],
  conceptContext?: string
): Promise<GradeResult> {
  return evaluationAgent.gradeAnswer(question, userAnswer, contentText, targetConcept, opts, referenceKeyPoints, conceptContext);
}

/**
 * Grade an MCQ or True/False answer deterministically (no LLM call).
 */
export function gradeMCQOrTF(
  userAnswer: string,
  correctAnswer: string,
  questionType: "mcq" | "true_false"
): GradeResult {
  return evaluationAgent.gradeMCQOrTF(userAnswer, correctAnswer, questionType);
}
