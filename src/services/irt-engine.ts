/**
 * KAQG-CAT IRT Engine (4PL MAP)
 *
 * Ability estimation via standard (unweighted) 4PL MAP Newton-Raphson.
 * Item selection via concept mastery loop:
 *   1. Re-ask failed important concepts (different edge direction each retry).
 *   2. Ask highest-importance untested concept.
 *   3. Pure Fisher Information once all important concepts resolved.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IRTResponse {
  difficulty: number;   // b — LLM-rated question difficulty
  a: number;            // discrimination (from contextual importance)
  c: number;            // lower asymptote (guessing; type-based)
  d: number;            // upper asymptote
  correct: boolean;
  score: number;
  bloomLevel: string;
}

export interface IRTState {
  theta: number;
  se: number;
  responses: IRTResponse[];
  converged: boolean;
}

export type ConceptStatus = 'untested' | 'mastered' | 'failed' | 'failed_final';

export interface ConceptMastery {
  conceptId: string;
  label: string;
  importance: number;
  status: ConceptStatus;
  askCount: number;
}

export type ConceptMasteryMap = Map<string, ConceptMastery>;

export interface QuestionTarget {
  targetConceptId: string | null;
  edgeDirection: 'direct' | 'incoming' | 'outgoing';
  b_target: number;
  bloomTarget: string;
}

export interface ItemTarget {
  difficulty: number;
  bloomTarget: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SE_THRESHOLD = 0.40;
const MAX_QUESTIONS = 15;
const MIN_QUESTIONS = 4;
const NEWTON_RAPHSON_ITERATIONS = 50;
const NEWTON_RAPHSON_TOLERANCE = 1e-6;

export const IRT_CORRECT_THRESHOLD = 70;
export const IMPORTANT_CONCEPT_THRESHOLD = 0.65;
export const MIN_IMPORTANT_CONCEPTS = 3;

/**
 * Item target (concept-mastery and Fisher mode alike):
 *
 *   b_target = clamp(offset + IMPORTANCE_WEIGHT × (importance − 0.5) + THETA_WEIGHT × θ, −2, 2)
 *   offset   = DIFFICULTY_OFFSET_SCALE × (difficulty − DIFFICULTY_NEUTRAL)     (config.difficulty)
 *
 *   difficulty 0.20 (easy)    → offset −0.875
 *   difficulty 0.40 (medium)  → offset −0.375
 *   difficulty 0.50 (default) → offset −0.125
 *   difficulty 0.65 (hard)    → offset +0.25
 *   range 0 … 1               → −1.375 … +1.125
 *
 * Why θ is damped (THETA_WEIGHT 0.5) instead of added in full: for an all-correct learner the
 * ability estimate is θ = (hardest item answered) + up to 1.0, so with b_target = θ + … every
 * correct answer raised the next target by ~0.35–1.0 on top of the previous one — medium reached
 * Evaluate/Create by question 4–5 and hard reached Create by question 2. With half of θ the
 * target converges instead of compounding: the setting fixes the centre of the band and θ moves
 * the target at most ±1 around it, in both directions (adaptivity kept). The importance term
 * (formerly × 1.5, always positive for important concepts and compounding through θ) is reduced
 * to a small nudge towards harder items for more central concepts.
 *
 * Simulated (LLM rating anchored per ITEM_DIFFICULTY_MAX_DEVIATION, 10 questions):
 *   easy   — strong learner: Understand (true/false, then MCQ); weak: Remember.
 *   medium — strong learner: Understand → Apply, never past Apply within 5 questions; mixed:
 *            Understand/Apply.
 *   hard   — strong learner: Apply → Analyze → Evaluate from question 3–4, Create not reachable
 *            (max target at θ = 2 is ≈ 1.45); weak: Apply → Understand.
 * Create is only reachable at difficulty ≳ 0.7. Targets are clamped to [−2, 2].
 */
export const DIFFICULTY_NEUTRAL = 0.55;
export const DIFFICULTY_OFFSET_SCALE = 2.5;
export const THETA_WEIGHT = 0.5;
export const IMPORTANCE_WEIGHT = 0.3;

/**
 * The item difficulty b fed to the IRT update is the LLM's own rating, but only within
 * ±ITEM_DIFFICULTY_MAX_DEVIATION (half a Bloom band) of the target it was generated for.
 * Uncalibrated LLM ratings drift (a live run rated every question 1.0 whatever the target), and an
 * unanchored b of 1.0 makes even wrong answers push θ up, which ratchets the session towards
 * Evaluate/Create. (Simulated with the original undamped target, easy sessions with an LLM that
 * always says 1.0 stayed on Understand/Apply over 10 questions with ±0.25 but drifted to
 * Analyze/open by question 4 with ±0.5.) The LLM may nudge b, not move it.
 */
export const ITEM_DIFFICULTY_MAX_DEVIATION = 0.25;

// ─── 4PL model ────────────────────────────────────────────────────────────────

/**
 * 4PL probability: P(θ) = c + (d−c) / (1 + exp(−a(θ−b)))
 */
export function probability(theta: number, b: number, a = 1.0, c = 0.0, d = 1.0): number {
  const z = a * (theta - b);
  if (z > 500) return d;
  if (z < -500) return c;
  return c + (d - c) / (1 + Math.exp(-z));
}

function fisherInfo4PL(
  theta: number, b: number, a: number, c: number, d: number
): number {
  const p = probability(theta, b, a, c, d);
  if (p <= c + 1e-9 || p >= d - 1e-9 || p <= 0 || p >= 1) return 0;
  // dP/dθ = a*(P−c)*(d−P)/(d−c)
  const dPdt = a * (p - c) * (d - p) / (d - c);
  return (dPdt * dPdt) / (p * (1 - p));
}

// ─── MAP estimation (unweighted 4PL) ────────────────────────────────────────

function estimateTheta(responses: IRTResponse[], initialTheta: number): number {
  if (responses.length === 0) return 0;

  const allCorrect = responses.every(r => r.correct);
  const allWrong   = responses.every(r => !r.correct);

  // All-correct / all-wrong: bounded heuristic around the hardest / easiest item, but never less
  // extreme than the MAP estimate in the direction of the evidence. Without that bound a wrong
  // answer on a moderately hard item (b = 0.6 → θ = 0.25) raised θ above the prior, and a correct
  // answer on an easy item lowered it, so the next item moved the wrong way.
  if (allCorrect) {
    const maxB = Math.max(...responses.map(r => r.difficulty));
    const heuristic = Math.min(2, maxB + Math.min(0.5 * Math.log(responses.length + 1), 1.0));
    return Math.max(heuristic, mapTheta(responses, initialTheta));
  }
  if (allWrong) {
    const minB = Math.min(...responses.map(r => r.difficulty));
    const heuristic = Math.max(-2, minB - Math.min(0.5 * Math.log(responses.length + 1), 1.0));
    return Math.min(heuristic, mapTheta(responses, initialTheta));
  }

  return mapTheta(responses, initialTheta);
}

/** MAP estimate (N(0,1) prior) by Newton-Raphson, clamped to [−2, 2]. */
function mapTheta(responses: IRTResponse[], initialTheta: number): number {
  let theta = initialTheta;

  for (let iter = 0; iter < NEWTON_RAPHSON_ITERATIONS; iter++) {
    let grad = 0;
    let hess = 0;

    for (const r of responses) {
      const p = probability(theta, r.difficulty, r.a, r.c, r.d);
      if (p <= r.c + 1e-9 || p >= r.d - 1e-9 || p <= 0 || p >= 1) continue;
      const dPdt = r.a * (p - r.c) * (r.d - p) / (r.d - r.c);
      const u = r.correct ? 1 : 0;
      grad += (u - p) * dPdt / (p * (1 - p));
      hess -= (dPdt * dPdt)  / (p * (1 - p));
    }

    // N(0,1) prior
    grad -= theta;
    hess -= 1;

    if (Math.abs(hess) < 1e-10) break;

    let delta = grad / hess;
    while (Math.abs(delta) > 1.5) delta /= 2;
    theta -= delta;
    theta = Math.max(-2, Math.min(2, theta));

    if (Math.abs(delta) < NEWTON_RAPHSON_TOLERANCE) break;
  }

  return theta;
}

function calculateSE(theta: number, responses: IRTResponse[]): number {
  if (responses.length === 0) return Infinity;
  let info = 1; // prior
  for (const r of responses) {
    info += fisherInfo4PL(theta, r.difficulty, r.a, r.c, r.d);
  }
  return info < 1e-10 ? Infinity : 1 / Math.sqrt(info);
}

// ─── State management ─────────────────────────────────────────────────────────

export function createIRTState(): IRTState {
  return { theta: 0, se: Infinity, responses: [], converged: false };
}

export function updateAbility(
  state: IRTState,
  difficulty: number,
  a: number,
  c: number,
  d: number,
  correct: boolean,
  score: number,
  bloomLevel: string
): IRTState {
  const newResponses: IRTResponse[] = [
    ...state.responses,
    { difficulty, a, c, d, correct, score, bloomLevel }
  ];

  const theta = estimateTheta(newResponses, state.theta);
  const se    = calculateSE(theta, newResponses);
  const converged =
    (newResponses.length >= MIN_QUESTIONS && se < SE_THRESHOLD) ||
    newResponses.length >= MAX_QUESTIONS;

  return { theta, se, responses: newResponses, converged };
}

// ─── Difficulty setting ──────────────────────────────────────────────────────

const clampB = (b: number): number => Math.max(-2, Math.min(2, b));

/** Target-difficulty offset for config.difficulty (0–1). See THETA_WEIGHT for the mapping. */
export function difficultyOffset(difficulty: number | undefined): number {
  if (typeof difficulty !== "number" || !Number.isFinite(difficulty)) return 0;
  const d = Math.max(0, Math.min(1, difficulty));
  return DIFFICULTY_OFFSET_SCALE * (d - DIFFICULTY_NEUTRAL);
}

/**
 * IRT item difficulty b for a generated question: the LLM's rating clamped to
 * target ± ITEM_DIFFICULTY_MAX_DEVIATION (and to [−2, 2]); the target itself when the rating is
 * missing or not a finite number. Idempotent.
 */
export function anchorItemDifficulty(rated: number | undefined, target: number): number {
  const t = clampB(target);
  if (typeof rated !== "number" || !Number.isFinite(rated)) return t;
  return clampB(Math.max(t - ITEM_DIFFICULTY_MAX_DEVIATION, Math.min(t + ITEM_DIFFICULTY_MAX_DEVIATION, rated)));
}

/** Target difficulty for the next item (see THETA_WEIGHT for the formula and its rationale). */
export function itemTarget(theta: number, importance: number | null, offset = 0): number {
  const nudge = importance == null ? 0 : IMPORTANCE_WEIGHT * (importance - 0.5);
  return clampB(offset + nudge + THETA_WEIGHT * theta);
}

// ─── Concept mastery item selection ──────────────────────────────────────────

/**
 * Select the next question target using the concept mastery loop.
 *
 * Priority:
 *   1. Failed (not failed_final) concepts — highest importance first.
 *      Edge direction rotates per askCount: direct→incoming→outgoing.
 *   2. Untested concepts — highest importance first, direct edge.
 *   3. All important concepts resolved — pure θ (Fisher mode).
 *
 * Targets follow itemTarget() (see THETA_WEIGHT): `offset` (from
 * difficultyOffset(config.difficulty)) sets the centre of the band, θ moves the target within it.
 */
export function selectNextQuestion(
  state: IRTState,
  conceptMastery: ConceptMasteryMap,
  offset = 0
): QuestionTarget {
  const theta = state.theta;

  const failed = [...conceptMastery.values()]
    .filter(c => c.status === 'failed')
    .sort((a, b) => b.importance - a.importance);

  if (failed.length > 0) {
    const concept = failed[0];
    const edge: 'incoming' | 'outgoing' = concept.askCount === 1 ? 'incoming' : 'outgoing';
    const b = itemTarget(theta, concept.importance, offset);
    return { targetConceptId: concept.conceptId, edgeDirection: edge, b_target: b, bloomTarget: difficultyToBloom(b) };
  }

  const untested = [...conceptMastery.values()]
    .filter(c => c.status === 'untested')
    .sort((a, b) => b.importance - a.importance);

  if (untested.length > 0) {
    const concept = untested[0];
    const b = itemTarget(theta, concept.importance, offset);
    return { targetConceptId: concept.conceptId, edgeDirection: 'direct', b_target: b, bloomTarget: difficultyToBloom(b) };
  }

  // All resolved — Fisher mode: no concept, so no importance nudge
  const b = itemTarget(theta, null, offset);
  return { targetConceptId: null, edgeDirection: 'direct', b_target: b, bloomTarget: difficultyToBloom(b) };
}

/**
 * Check if all important concepts are resolved (mastered or failed_final)
 * and SE is below threshold.
 */
export function isConceptMasteryComplete(
  conceptMastery: ConceptMasteryMap,
  se: number
): boolean {
  if (conceptMastery.size === 0) return false;
  const allResolved = [...conceptMastery.values()].every(
    c => c.status === 'mastered' || c.status === 'failed_final'
  );
  return allResolved && se < SE_THRESHOLD;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export function isConverged(state: IRTState): boolean {
  return state.converged;
}

export function isAberrant(state: IRTState): boolean {
  const r = state.responses;
  if (r.length < 4) return false;
  if (!r.every(resp => resp.correct)) return false;
  const meanDiff = r.reduce((s, resp) => s + resp.difficulty, 0) / r.length;
  return meanDiff >= state.theta + 0.5;
}

/**
 * Map θ ∈ [−2, 2] → score ∈ [0, 100].
 */
export function thetaToScore(theta: number): number {
  const clamped = Math.max(-2, Math.min(2, theta));
  return Math.round((clamped + 2) / 4 * 100);
}

export function difficultyToBloom(difficulty: number): string {
  if (difficulty < -1.0) return "Remember";
  if (difficulty < 0.0)  return "Understand";
  if (difficulty < 0.5)  return "Apply";
  if (difficulty < 1.0)  return "Analyze";
  if (difficulty < 1.5)  return "Evaluate";
  return "Create";
}

export function bloomToDifficulty(bloomLevel: string): number {
  switch (bloomLevel) {
    case "Remember":   return -1.5;
    case "Understand": return -0.5;
    case "Apply":      return 0.25;
    case "Analyze":    return 0.75;
    case "Evaluate":   return 1.25;
    case "Create":     return 1.75;
    default:           return 0;
  }
}

/** Type-based lower asymptote (guessing probability). */
export function questionTypeC(qType: string): number {
  if (qType === "true_false") return 0.50;
  if (qType === "mcq")        return 0.25;
  return 0.00; // open
}

/** @deprecated Use selectNextQuestion() */
export function selectNextTarget(
  state: IRTState,
  _bloomCoverage: Record<string, number>,
  _questionNumber: number,
  _maxQuestions: number
): ItemTarget {
  return { difficulty: state.theta, bloomTarget: difficultyToBloom(state.theta) };
}

/** @deprecated */
export function selectNextDifficulty(state: IRTState): number {
  return Math.max(-2, Math.min(2, state.theta));
}

/** Bloom coverage type kept for snapshot backward compatibility. */
export type BloomCoverage = Record<string, number>;
