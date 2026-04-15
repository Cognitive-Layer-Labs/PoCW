/**
 * PoCW SDK — Public Types, Interfaces, and Errors
 */

// ─── Question Types ──────────────────────────────────────────────────────────

export type QuestionType = "open" | "mcq" | "true_false" | "scenario";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ChainConfig {
  controllerAddress: string;
  sbtAddress: string;
  rpc?: string;
}

export interface PoCWConfig {
  /** Maximum questions before session ends. Default: 10 */
  max_questions?: number;
  /** Starting difficulty 0-1. Default: 0.5. Maps to IRT b = (val*6)-3 */
  difficulty?: number;
  /** Question types to use. Default: ["open"] */
  q_types?: QuestionType[];
  /** Pass/fail threshold 0-1. Default: 0.7 */
  threshold?: number;
  /** Response detail level. Default: "score" */
  response?: "boolean" | "score" | "detailed";
  /** Override LLM model (OpenRouter model ID) */
  model?: string;
  /** Attestation mode. Default: "none" */
  attest?: "onchain" | "offchain" | "none";
  /** Chain config for on-chain attestation */
  chain?: ChainConfig;
  /** Question language. Default: auto-detect from content */
  language?: string;
  /** Persona framing for questions (e.g. "explain to a 5-year-old") */
  persona?: string;
  /** Callback for receiving questions — if set, verify() returns PoCWResult directly */
  onQuestion?: (question: VerifyQuestion) => Promise<string>;
}

export const DEFAULT_CONFIG: Required<
  Pick<PoCWConfig, "max_questions" | "difficulty" | "q_types" | "threshold" | "response" | "attest">
> = {
  max_questions: 10,
  difficulty: 0.5,
  q_types: ["open"],
  threshold: 0.7,
  response: "score",
  attest: "none",
};

/** Internal resolved config with defaults applied */
export interface ResolvedConfig {
  max_questions: number;
  difficulty: number;
  q_types: QuestionType[];
  threshold: number;
  response: "boolean" | "score" | "detailed";
  model?: string;
  attest: "onchain" | "offchain" | "none";
  chain?: ChainConfig;
  language?: string;
  persona?: string;
}

export function resolveConfig(config?: PoCWConfig): ResolvedConfig {
  return {
    max_questions: config?.max_questions ?? DEFAULT_CONFIG.max_questions,
    difficulty: config?.difficulty ?? DEFAULT_CONFIG.difficulty,
    q_types: config?.q_types ?? DEFAULT_CONFIG.q_types,
    threshold: config?.threshold ?? DEFAULT_CONFIG.threshold,
    response: config?.response ?? DEFAULT_CONFIG.response,
    model: config?.model,
    attest: config?.attest ?? DEFAULT_CONFIG.attest,
    chain: config?.chain,
    language: config?.language,
    persona: config?.persona,
  };
}

/** Map 0-1 config difficulty to IRT b parameter (-3 to 3) */
export function configDifficultyToIRT(d: number): number {
  return Math.max(-3, Math.min(3, d * 6 - 3));
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
    accuracy: number;
    depth: number;
    specificity: number;
    reasoning: number;
  };
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
}

// ─── Attestation ─────────────────────────────────────────────────────────────

export interface OnchainAttestation {
  type: "onchain";
  signature: string;
  contentId: number;
  score: number;
  oracle: string;
  controllerAddress: string;
  sbtAddress: string;
  /** Replay protection: unique bytes32 nonce (0x-prefixed hex) included in the signed payload */
  nonce: string;
  /** Replay protection: Unix timestamp (seconds) after which signature is invalid */
  expiry: number;
  /** Base64 data URI (data:application/json;base64,...) stored on-chain as the token URI */
  tokenUri: string;
  /** SHA-256 hex digest of the metadata JSON */
  contentHash: string;
}

export interface OffchainAttestation {
  type: "offchain";
  signature: string;
  contentId: number;
  score: number;
  oracle: string;
  /** Replay protection: unique bytes32 nonce (0x-prefixed hex) included in the signed payload */
  nonce: string;
  /** Replay protection: Unix timestamp (seconds) after which signature is invalid */
  expiry: number;
  /** Base64 data URI (data:application/json;base64,...) stored on-chain as the token URI */
  tokenUri: string;
  /** SHA-256 hex digest of the metadata JSON */
  contentHash: string;
}

export type AttestationResult = OnchainAttestation | OffchainAttestation;

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
    "The competence indicator threshold is a configurable heuristic (default 0.7 = theta ~1.6). " +
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
  attestation?: AttestationResult;
  knowledgeId: string;
  contentId: number;
  subject: string;
  timestamp: string;
  /** Base64 data URI of the ERC-1155 metadata (present when attestation type is onchain/offchain) */
  tokenUri?: string;
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
  | "ATTESTATION_ERROR"
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
