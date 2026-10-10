/**
 * PoCW SDK — Public Types, Interfaces, and Errors
 */

// ─── Question Types ──────────────────────────────────────────────────────────

export type QuestionType = "open" | "mcq" | "true_false";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface PoCWConfig {
  /** Exact number of questions in the session (1–50). Default: 10, or the preset's count.
   *  An explicit value always wins over a preset. The session never stops early or expands. */
  max_questions?: number;
  /**
   * Difficulty preset. Overrides `difficulty` and `threshold` (and supplies `max_questions`
   * when the caller does not pass one).
   *   easy   → difficulty 0.2, threshold 0.35, 10 questions (good for general audiences)
   *   medium → difficulty 0.4, threshold 0.50, 15 questions
   *   hard   → difficulty 0.65, threshold 0.65, 20 questions
   */
  difficulty_preset?: "easy" | "medium" | "hard";
  /** Difficulty 0-1. Default: 0.5. Sets the centre of the item-difficulty band (and so the Bloom
   *  level and, in mixed sessions, the question type): offset 2.5 × (difficulty − 0.55) on the IRT
   *  scale — 0.2 → −0.875 (Remember/Understand), 0.4 → −0.375 (Understand/Apply), 0.65 → +0.25
   *  (Apply/Analyze, Evaluate after several correct answers). θ moves the target up or down within
   *  ±1 of that centre (see itemTarget in irt-engine.ts). */
  difficulty?: number;
  /** Question types to use. Default: all three. Only these types are ever asked (incl. fallbacks). */
  q_types?: QuestionType[];
  /** Pass/fail threshold 0-1. Default: 0.7 */
  threshold?: number;
  /** Response detail level. Default: "score" */
  response?: "boolean" | "score" | "detailed";
  /** Override LLM model (OpenRouter model ID) */
  model?: string;
  /** Question language. Default: auto-detect from content */
  language?: string;
  /** Persona framing for questions (e.g. "explain to a 5-year-old") */
  persona?: string;
  /** Callback for receiving questions — if set, verify() returns PoCWResult directly */
  onQuestion?: (question: VerifyQuestion) => Promise<string>;
}

export const DEFAULT_CONFIG: Required<
  Pick<PoCWConfig, "max_questions" | "difficulty" | "q_types" | "threshold" | "response">
> = {
  max_questions: 10,
  difficulty: 0.5,
  q_types: ["open", "mcq", "true_false"],
  threshold: 0.7,
  response: "score",
};

/** Internal resolved config with defaults applied */
export interface ResolvedConfig {
  /** Exact number of questions in the session. */
  max_questions: number;
  difficulty: number;
  q_types: QuestionType[];
  threshold: number;
  importance_threshold: number;
  response: "boolean" | "score" | "detailed";
  model?: string;
  language?: string;
  persona?: string;
}

const DIFFICULTY_PRESETS: Record<string, {
  difficulty: number;
  threshold: number;
  importance_threshold: number;
  max_questions: number;
}> = {
  easy:   { difficulty: 0.20, threshold: 0.35, importance_threshold: 0.80, max_questions: 10 },
  medium: { difficulty: 0.40, threshold: 0.50, importance_threshold: 0.65, max_questions: 15 },
  hard:   { difficulty: 0.65, threshold: 0.65, importance_threshold: 0.50, max_questions: 20 },
};

export function resolveConfig(config?: PoCWConfig): ResolvedConfig {
  const preset = config?.difficulty_preset ? DIFFICULTY_PRESETS[config.difficulty_preset] : null;
  return {
    // An explicit max_questions is the exact session length, even with a preset.
    max_questions: config?.max_questions ?? preset?.max_questions ?? DEFAULT_CONFIG.max_questions,
    difficulty: preset?.difficulty ?? config?.difficulty ?? DEFAULT_CONFIG.difficulty,
    q_types: config?.q_types ?? DEFAULT_CONFIG.q_types,
    threshold: preset?.threshold ?? config?.threshold ?? DEFAULT_CONFIG.threshold,
    importance_threshold: preset?.importance_threshold ?? 0.65,
    response: config?.response ?? DEFAULT_CONFIG.response,
    model: config?.model,
    language: config?.language,
    persona: config?.persona,
  };
}

// ─── PoCW Init Config ────────────────────────────────────────────────────────

export interface PoCWInitConfig {
  /** Path to SQLite database file. Default: ./data/pocw.db */
  dbPath?: string;
}

// ─── Indexing ────────────────────────────────────────────────────────────────

export type IndexStatus = "pending" | "indexing" | "ready" | "failed";

export interface IndexResult {
  knowledgeId: string;
  status: IndexStatus;
  contentId?: number;
  error?: string;
  /** Book author when one was detected (EPUB, PDF info, Project Gutenberg header). */
  author?: string;
}

// ─── Content Store Row ───────────────────────────────────────────────────────

export interface ContentRow {
  knowledge_id: string;
  content_type: string;
  source: string;
  title: string | null;
  description: string | null;
  status: IndexStatus;
  error: string | null;
  content_id: number | null;
  content_hash: string | null;
  chunk_count: number;
  created_at: string;
  indexed_at: string | null;
  usage_count: number;
  last_used_at: string | null;
  /** 1 = hidden from the public catalog (admin toggle); 0/NULL = visible. */
  hidden: number | null;
  /** Author detected from the file (EPUB dc:creator, PDF info Author, Gutenberg header); NULL if none. */
  author: string | null;
}

// ─── Verification Question ───────────────────────────────────────────────────

export interface VerifyQuestion {
  text: string;
  number: number;
  type: QuestionType;
  bloomLevel: string;
  difficulty: number;
  totalQuestions: number;
  /** MCQ options (4 items). Undefined for other types. */
  options?: string[];
}

// ─── Answer Feedback ─────────────────────────────────────────────────────────

export interface AnswerFeedback {
  correct: boolean;
  score: number;
  reasoning: string;
  dimensions?: {
    covered_points: number;
    total_points: number;
    precision_cap: number;
  };
  /** IRT parameters used for this item and the resulting ability shift.
   *  a ← contextual importance, b ← LLM difficulty rating anchored to the item target (±0.25),
   *  c ← question type, d ← constant. */
  irtParams?: {
    a: number;
    b: number;
    c: number;
    d: number;
    importance: number;
    theta_before: number;
  };
  /** Reference key points for open questions (from question generation). */
  referenceKeyPoints?: string[];
  /** Correct answer text for MCQ / true_false questions. */
  correctAnswer?: string;
  progress: {
    questionNumber: number;
    theta: number;
    se: number;
    bloomLevel: string;
  };
  isComplete: boolean;
}

// ─── Score Breakdown (for response="detailed") ──────────────────────────────

export interface ScoreBreakdown {
  question: string;
  type: QuestionType;
  score: number;
  difficulty: number;
  bloomLevel: string;
  correct: boolean;
  /** KG concept the question targeted, or null when it could not be tied to a known concept. */
  conceptId: string | null;
}

// ─── Per-concept outcome ─────────────────────────────────────────────────────

export interface ConceptOutcome {
  /** KG node id */
  id: string;
  /** KG node label */
  label: string;
  /** Number of questions that targeted this concept */
  asked: number;
  /** Number of those answered correctly */
  correct: number;
  /** True when the concept-mastery loop marked the concept as mastered */
  mastered: boolean;
}

// ─── Cognitive profile (descriptive session summary) ─────────────────────────

export interface CognitiveProfile {
  /** Content title (from the content index) */
  title: string;
  /** Original source (URL or raw-text marker) */
  source: string;
  /** Distinct Bloom levels of correctly answered questions */
  bloomLevelsReached: string[];
  /** Number of questions asked per Bloom level */
  bloomCoverage: Record<string, number>;
  /** Person-fit flag: response pattern is potentially aberrant */
  aberrant: boolean;
  /** Distinct question types used in the session */
  questionTypes: QuestionType[];
}

// ─── Final Result ────────────────────────────────────────────────────────────

export interface PoCWDisclaimers {
  irtCalibration: string;
  bloomMapping: string;
  thresholdSemantics: string;
}

export const POCW_DISCLAIMERS: PoCWDisclaimers = {
  irtCalibration:
    "IRT ability (theta) is estimated from LLM-assigned item difficulties, not empirically " +
    "calibrated against a population of test-takers. Values are relative, not absolute.",
  bloomMapping:
    "Bloom's taxonomy levels are derived from a linear IRT difficulty mapping with " +
    "arbitrary thresholds. They describe approximate cognitive complexity, not certified task types.",
  thresholdSemantics:
    "The competence indicator threshold is a configurable heuristic (default 0.7 = theta ~0.8). " +
    "It does not correspond to a validated psychometric standard.",
};

export interface PoCWResult {
  /** Heuristic competence indicator. See disclaimers for interpretation guidance. */
  competenceIndicator: boolean;
  score: number;
  theta: number;
  se: number;
  converged: boolean;
  confidence_interval: [number, number];
  questions_asked: number;
  response_detail?: ScoreBreakdown[];
  /** Per-concept outcomes for the important concepts tracked by the session. Always present. */
  concepts: ConceptOutcome[];
  /** Descriptive summary of the session (Bloom coverage, question types, person-fit). */
  profile: CognitiveProfile;
  knowledgeId: string;
  contentId: number;
  subject: string;
  timestamp: string;
  /** Disclaimer text explaining the heuristic nature of the measurements */
  disclaimers: PoCWDisclaimers;
}

// ─── Generation Options (internal, passed to question generator) ─────────────

export interface GenerationOpts {
  language?: string;
  persona?: string;
  model?: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type PoCWErrorCode =
  | "CONTENT_NOT_FOUND"
  | "INDEXING_IN_PROGRESS"
  | "INDEXING_FAILED"
  | "SESSION_EXPIRED"
  | "SESSION_NOT_ACTIVE"
  | "INVALID_CONFIG"
  | "LLM_ERROR"
  | "GRAPH_DB_ERROR"
  | "CAPACITY_EXCEEDED";

export class PoCWError extends Error {
  public readonly code: PoCWErrorCode;
  public readonly cause?: Error;

  constructor(code: PoCWErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = "PoCWError";
    this.code = code;
    this.cause = cause;
  }
}
