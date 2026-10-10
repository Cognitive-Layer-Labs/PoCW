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
 */

import { QuestionType, GenerationOpts } from "../sdk/types";
import { QuestionGenerationAgent, QuestionGenerationError, GeneratedQuestion } from "./question-generation-agent";
import { QuestionEvaluationAgent, GradeResult } from "./question-evaluation-agent";
import { difficultyToBloom } from "./irt-engine";

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
 * Generate a single question and verify its quality.
 *
 * Loop:
 *   1. Generation Agent produces a question at targetDifficulty / targetBloom.
 *   2. Evaluation Agent checks quality (answerability, Bloom match, MCQ distractors).
 *   3. If quality check passes → return question.
 *   4. If fails → pass evaluator feedback back to Generation Agent and retry.
 * Max eval retries: 2 (after that, accept whatever passes format validation).
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
  const targetBloom = difficultyToBloom(targetDifficulty);
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
