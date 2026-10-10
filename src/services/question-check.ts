/**
 * Question check ("System One", before a question is shown).
 *
 * One decisions call (question-check-model, e.g. typesafe/jev-1.13) per generated question:
 *   - MCQ only: correct_option — which option is correct according to the passage
 *     (criteria = the 4 options). Jev picks a different option than the key with
 *     confidence ≥ 0.6 → regenerate.
 *   - answerable_from_passage (yes / no) and plainly_worded (yes / no): either "no" with
 *     confidence ≥ 0.7 → regenerate.
 *
 * The caller regenerates at most once and keeps the question whenever the check fails or errors.
 * Outcomes are stored on the call-log row ("pass" / "regenerate:<reasons>") and counted in memory.
 */

import { decide, choiceAnswer, DecisionAnswer, DecisionQuestion } from "./decisions-client";
import { decisionsModel } from "./ai-config";
import { setCallOutcome } from "./usage-store";
import type { GeneratedQuestion } from "./question-generation-agent";

/** Jev must be at least this sure that another MCQ option is the right one. */
export const KEY_MISMATCH_CONFIDENCE = 0.6;
/** Jev must be at least this sure that a question is unanswerable / not plainly worded. */
export const REJECT_CONFIDENCE = 0.7;
const PASSAGE_CHARS = 6000;
const LETTERS = ["A", "B", "C", "D"];

export type CheckReason = "key_mismatch" | "not_answerable" | "not_plain";

export interface QuestionCheckResult {
  /** skipped: no question-check-model configured; error: the check failed (question kept). */
  status: "pass" | "regenerate" | "skipped" | "error";
  reasons: CheckReason[];
  /** Instructions for the regeneration prompt (status "regenerate"). */
  feedback?: string;
  /** MCQ: the option Jev considers correct. */
  jevChoice?: string;
}

export interface QuestionCheckStats {
  checked: number;
  passed: number;
  regenerated: number;
  errors: number;
  reasons: Record<CheckReason, number>;
}

const stats: QuestionCheckStats = {
  checked: 0, passed: 0, regenerated: 0, errors: 0,
  reasons: { key_mismatch: 0, not_answerable: 0, not_plain: 0 },
};

/** In-process counters since start (the call log keeps the persistent record). */
export function getQuestionCheckStats(): QuestionCheckStats {
  return { ...stats, reasons: { ...stats.reasons } };
}

export function __resetQuestionCheckStatsForTest(): void {
  stats.checked = stats.passed = stats.regenerated = stats.errors = 0;
  stats.reasons = { key_mismatch: 0, not_answerable: 0, not_plain: 0 };
}

let lastErrorLog = 0;

/** Decisions request for one generated question. */
export function buildQuestionCheckRequest(
  model: string,
  q: GeneratedQuestion,
  passage: string,
): { model: string; state: Record<string, unknown>; questions: Record<string, DecisionQuestion> } {
  const isTF = q.type === "true_false";
  const state: Record<string, unknown> = {
    task: "A quiz item was written about this passage of a book, for a reader who has read the book. Check it before it is shown.",
    passage: passage.slice(0, PASSAGE_CHARS),
  };
  const questions: Record<string, DecisionQuestion> = {};

  if (isTF) {
    state.statement = q.question;
  } else {
    state.question = q.question;
  }
  if (q.type === "mcq" && q.options?.length === 4) {
    const options: Record<string, string> = {};
    q.options.forEach((o, i) => { options[LETTERS[i]] = o; });
    state.options = options;
    questions.correct_option = {
      type: "choice",
      instructions: "Which option is correct according to the passage?",
      criteria: options,
    };
  }
  questions.answerable_from_passage = {
    type: "choice",
    instructions: isTF
      ? "Can a reader tell from the passage alone whether the statement is true or false?"
      : "Can the question be answered from the passage alone?",
    criteria: {
      yes: "Yes: the passage clearly contains what is needed.",
      no: "No: the answer is not in the passage, or needs outside knowledge or guessing.",
    },
  };
  questions.plainly_worded = {
    type: "choice",
    instructions: isTF ? "Is the statement plainly worded?" : "Is the question plainly worded?",
    criteria: isTF
      ? {
          yes: "One short statement of a single fact, in everyday words.",
          no: "Academic or jargon-heavy, several claims at once, long-winded or convoluted.",
        }
      : {
          yes: "One short question in everyday words, the way a friend who read the book would ask; it asks for one thing.",
          no: "Academic or jargon-heavy, multi-part, long-winded or convoluted.",
        },
  };
  return { model, state, questions };
}

/** Reasons to regenerate (empty → pass). */
export function interpretQuestionCheck(
  q: GeneratedQuestion,
  answers: Record<string, DecisionAnswer>,
): { reasons: CheckReason[]; jevChoice?: string } {
  const reasons: CheckReason[] = [];
  let jevChoice: string | undefined;
  if (q.type === "mcq" && answers.correct_option) {
    const a = choiceAnswer({ answers }, "correct_option");
    jevChoice = a.choice;
    const key = (q.correctAnswer ?? "").trim().toUpperCase();
    if (key && a.choice !== key && a.confidence >= KEY_MISMATCH_CONFIDENCE) reasons.push("key_mismatch");
  }
  const answerable = choiceAnswer({ answers }, "answerable_from_passage");
  if (answerable.choice === "no" && answerable.confidence >= REJECT_CONFIDENCE) reasons.push("not_answerable");
  const plain = choiceAnswer({ answers }, "plainly_worded");
  if (plain.choice === "no" && plain.confidence >= REJECT_CONFIDENCE) reasons.push("not_plain");
  return { reasons, jevChoice };
}

/** Feedback for the regeneration prompt. */
export function regenerationFeedback(q: GeneratedQuestion, reasons: CheckReason[], jevChoice?: string): string {
  const kind = q.type === "true_false" ? "statement" : "question";
  const lines = [`A quality check rejected the previous ${kind}: "${q.question}"`];
  if (reasons.includes("key_mismatch")) {
    const idx = jevChoice ? LETTERS.indexOf(jevChoice) : -1;
    const text = idx >= 0 && q.options ? ` ("${q.options[idx]}")` : "";
    lines.push(
      `- Its answer key looked wrong: the passage seems to support option ${jevChoice}${text}, not ${q.correctAnswer}. ` +
      `Make sure exactly one option is correct according to CONTENT_TEXT and that correctAnswer points to it.`,
    );
  }
  if (reasons.includes("not_answerable")) {
    lines.push("- It could not be answered from CONTENT_TEXT alone. Ask about something the passage states clearly.");
  }
  if (reasons.includes("not_plain")) {
    lines.push("- It was not plainly worded. Use one short sentence (at most about 20 words) in everyday words, asking for one thing — like a friend who read the book.");
  }
  lines.push(`Write a different ${kind}; do not reuse the rejected wording.`);
  return lines.join("\n");
}

/** Check one generated question. Never throws. */
export async function checkQuestion(q: GeneratedQuestion, passage: string): Promise<QuestionCheckResult> {
  const model = decisionsModel("question-check-model");
  if (!model) return { status: "skipped", reasons: [] };

  let interpreted: { reasons: CheckReason[]; jevChoice?: string };
  let callId: number | null = null;
  try {
    const result = await decide(buildQuestionCheckRequest(model, q, passage), { task: "question_check" });
    callId = result.callId;
    interpreted = interpretQuestionCheck(q, result.answers);
  } catch (err) {
    stats.errors++;
    if (Date.now() - lastErrorLog > 60_000) {
      lastErrorLog = Date.now();
      console.warn(`[question-check] check failed, keeping the question (${stats.errors} errors so far): ${err instanceof Error ? err.message : err}`);
    }
    return { status: "error", reasons: [] };
  }

  stats.checked++;
  const { reasons, jevChoice } = interpreted;
  if (reasons.length === 0) {
    stats.passed++;
    setCallOutcome(callId, "pass");
    return { status: "pass", reasons, jevChoice };
  }
  stats.regenerated++;
  for (const r of reasons) stats.reasons[r]++;
  setCallOutcome(callId, `regenerate:${reasons.join("+")}`);
  console.log(
    `[question-check] ${q.type} rejected (${reasons.join(", ")}) → regenerating once. ` +
    `Totals: ${stats.checked} checked, ${stats.passed} passed, ${stats.regenerated} regenerated, ${stats.errors} errors.`,
  );
  return { status: "regenerate", reasons, feedback: regenerationFeedback(q, reasons, jevChoice), jevChoice };
}
