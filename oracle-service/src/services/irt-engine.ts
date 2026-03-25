/**
 * 1PL (Rasch) Item Response Theory Engine
 *
 * Implements ability estimation (θ) using Maximum Likelihood Estimation
 * with Newton-Raphson iteration, Fisher Information for standard error,
 * and adaptive item selection.
 */

export interface IRTResponse {
  difficulty: number;   // b parameter of the item
  correct: boolean;     // binary outcome
  score: number;        // granular 0-100 score for profile
  bloomLevel: string;   // Bloom's Taxonomy level of the item
}

export interface IRTState {
  theta: number;                  // current ability estimate
  se: number;                     // standard error of theta
  responses: IRTResponse[];       // history of all responses
  converged: boolean;             // whether estimation has converged
}

const SE_THRESHOLD = 0.5;
const MAX_QUESTIONS = 15;
const MIN_QUESTIONS = 3;
const NEWTON_RAPHSON_ITERATIONS = 50;
const NEWTON_RAPHSON_TOLERANCE = 1e-6;

/** IRT correct/incorrect threshold: score >= this is "correct" */
export const IRT_CORRECT_THRESHOLD = 60;

/**
 * Probability of correct response under 1PL model.
 * P(correct | θ, b) = 1 / (1 + e^(-(θ - b)))
 */
export function probability(theta: number, difficulty: number): number {
  const z = theta - difficulty;
  // Clamp to prevent exp() overflow and ensure p*(1-p) never collapses to 0
  if (z > 500) return 1 - 1e-10;
  if (z < -500) return 1e-10;
  return 1 / (1 + Math.exp(-z));
}

/**
 * Fisher Information for a single item at given θ.
 * I(θ) = P(θ) * (1 - P(θ))
 */
function fisherInformation(theta: number, difficulty: number): number {
  const p = probability(theta, difficulty);
  return p * (1 - p);
}

/**
 * Create initial IRT state.
 */
export function createIRTState(): IRTState {
  return {
    theta: 0,
    se: Infinity,
    responses: [],
    converged: false
  };
}

/**
 * Estimate θ using MAP (Maximum A Posteriori) with N(0,1) prior.
 * This is Newton-Raphson on the penalized log-likelihood:
 *
 *   L(θ) = Σ [ u_i * ln(P_i) + (1 - u_i) * ln(1 - P_i) ] - θ²/2
 *   L'(θ) = Σ [ u_i - P_i ] - θ
 *   L''(θ) = -Σ [ P_i * (1 - P_i) ] - 1
 *
 * The prior regularizes θ toward 0, preventing wild jumps from
 * small samples (e.g., θ=2.0 after a single correct answer).
 */
function estimateTheta(responses: IRTResponse[], initialTheta: number): number {
  if (responses.length === 0) return 0;

  // Edge case: all correct or all wrong — MLE diverges.
  // Use damped estimate that grows slowly with sample size.
  const allCorrect = responses.every(r => r.correct);
  const allWrong = responses.every(r => !r.correct);

  if (allCorrect) {
    const maxB = Math.max(...responses.map(r => r.difficulty));
    // Step grows as ~0.5*ln(n+1), capped at 1.5
    return maxB + Math.min(0.5 * Math.log(responses.length + 1), 1.5);
  }
  if (allWrong) {
    const minB = Math.min(...responses.map(r => r.difficulty));
    return minB - Math.min(0.5 * Math.log(responses.length + 1), 1.5);
  }

  let theta = initialTheta;

  for (let iter = 0; iter < NEWTON_RAPHSON_ITERATIONS; iter++) {
    let firstDerivative = 0;
    let secondDerivative = 0;

    for (const response of responses) {
      const p = probability(theta, response.difficulty);
      const u = response.correct ? 1 : 0;
      firstDerivative += u - p;
      secondDerivative -= p * (1 - p);
    }

    // N(0,1) prior contribution: pulls θ toward 0
    firstDerivative -= theta;
    secondDerivative -= 1;

    if (Math.abs(secondDerivative) < 1e-10) break;

    let delta = firstDerivative / secondDerivative;
    // Dampen large steps to prevent oscillation
    while (Math.abs(delta) > 2) delta /= 2;
    theta -= delta;

    // Clamp θ to reasonable range [-4, 4]
    theta = Math.max(-4, Math.min(4, theta));

    if (Math.abs(delta) < NEWTON_RAPHSON_TOLERANCE) break;
  }

  return theta;
}

/**
 * Calculate standard error of θ.
 * SE(θ) = 1 / sqrt(Σ I_i(θ) + I_prior)
 * The N(0,1) prior contributes I_prior = 1 (consistent with MAP estimation).
 */
function calculateSE(theta: number, responses: IRTResponse[]): number {
  if (responses.length === 0) return Infinity;

  let totalInfo = 0;
  for (const response of responses) {
    totalInfo += fisherInformation(theta, response.difficulty);
  }

  // Add prior information (from N(0,1) prior used in MAP estimation)
  totalInfo += 1;

  if (totalInfo < 1e-10) return Infinity;
  return 1 / Math.sqrt(totalInfo);
}

/**
 * Update ability estimate after a new response.
 * Returns a new IRTState (immutable).
 */
export function updateAbility(
  state: IRTState,
  difficulty: number,
  correct: boolean,
  score: number,
  bloomLevel: string
): IRTState {
  const newResponses: IRTResponse[] = [
    ...state.responses,
    { difficulty, correct, score, bloomLevel }
  ];

  const theta = estimateTheta(newResponses, state.theta);
  const se = calculateSE(theta, newResponses);
  const converged =
    (newResponses.length >= MIN_QUESTIONS && se < SE_THRESHOLD) ||
    newResponses.length >= MAX_QUESTIONS;

  return { theta, se, responses: newResponses, converged };
}

/**
 * Select the optimal difficulty for the next item.
 * Under 1PL, maximum information is at b = θ.
 * We add small jitter to avoid identical-difficulty items.
 */
export function selectNextDifficulty(state: IRTState): number {
  // Small jitter for exploration: ±0.2
  const jitter = (Math.random() - 0.5) * 0.4;
  return Math.max(-3, Math.min(3, state.theta + jitter));
}

/**
 * Map IRT difficulty (b) to Bloom's Taxonomy level.
 *
 *   b < -1.0  → Remember
 *  -1.0 ≤ b < 0.0  → Understand
 *   0.0 ≤ b < 0.5  → Apply
 *   0.5 ≤ b < 1.0  → Analyze
 *   1.0 ≤ b < 1.5  → Evaluate
 *   b ≥ 1.5  → Create
 */
export function difficultyToBloom(difficulty: number): string {
  if (difficulty < -1.0) return "Remember";
  if (difficulty < 0.0) return "Understand";
  if (difficulty < 0.5) return "Apply";
  if (difficulty < 1.0) return "Analyze";
  if (difficulty < 1.5) return "Evaluate";
  return "Create";
}

/**
 * Map Bloom's Taxonomy level to approximate IRT difficulty midpoint.
 */
export function bloomToDifficulty(bloomLevel: string): number {
  switch (bloomLevel) {
    case "Remember":    return -1.5;
    case "Understand":  return -0.5;
    case "Apply":       return 0.25;
    case "Analyze":     return 0.75;
    case "Evaluate":    return 1.25;
    case "Create":      return 1.75;
    default:            return 0;
  }
}

/**
 * Check if the adaptive test should continue.
 */
export function isConverged(state: IRTState): boolean {
  return state.converged;
}

/**
 * Compute a final normalized score from θ.
 * Maps θ ∈ [-4, 4] to score ∈ [0, 100].
 */
export function thetaToScore(theta: number): number {
  const clamped = Math.max(-4, Math.min(4, theta));
  const normalized = (clamped + 4) / 8; // [0, 1]
  return Math.round(normalized * 100);
}
