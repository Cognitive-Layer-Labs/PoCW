/**
 * VerifySession — Interactive Verification Session
 *
 * Wraps the IRT engine, question generator, and grading into a single
 * session object that callers drive by submitting answers.
 */

import { randomUUID } from "crypto";
import {
  createIRTState,
  updateAbility,
  selectNextQuestion,
  isConceptMasteryComplete,
  thetaToScore,
  difficultyToBloom,
  isAberrant,
  questionTypeC,
  IRTState,
  IRTResponse,
  ConceptMastery,
  ConceptMasteryMap,
  BloomCoverage,
  IMPORTANT_CONCEPT_THRESHOLD,
  MIN_IMPORTANT_CONCEPTS,
  BLOOM_WEIGHTS,
} from "../services/irt-engine";
import { getImportantConcepts } from "../services/kg-store";
import {
  generateQuestion,
  gradeAnswer,
  gradeMCQOrTF,
  GeneratedQuestion,
  GradeResult,
} from "../services/question-generator";
import { selectChunkIndex } from "../services/session-manager";
import {
  buildDataUri,
  buildErc1155Metadata,
  saveCognitiveProfile,
  CognitiveProfile,
} from "../services/metadata-store";
import { parseEther } from "ethers";
import { buildAttestation } from "./attestation";
import { getOracleAddress } from "../services/signer";
import { getContent } from "./content-store";
import {
  ResolvedConfig,
  QuestionType,
  VerifyQuestion,
  AnswerFeedback,
  PoCWResult,
  ScoreBreakdown,
  GenerationOpts,
  PoCWError,
  POCW_DISCLAIMERS,
  configDifficultyToIRT,
} from "./types";

/** Fixed 4PL upper asymptote: max P(correct) even at high ability (models ~5% slip). */
const IRT_D_CONSTANT = 0.95;

interface QuestionEntry {
  question: string;
  type: QuestionType;
  difficulty: number;
  bloomLevel: string;
  targetConcept: string;
  userAnswer?: string;
  score?: number;
  correct?: boolean;
  reasoning?: string;
}

/** Snapshot shape for Redis persistence. */
export interface SessionSnapshot {
  sessionId: string;
  createdAt: number;
  contentId: number;
  knowledgeId: string;
  subject: string;
  config: ResolvedConfig;
  chunkUsageCount: number[];
  bloomCoverage: BloomCoverage;
  conceptMastery: Array<[string, ConceptMastery]>;
  currentTarget: { conceptId: string | null; edgeDirection: 'direct' | 'incoming' | 'outgoing' };
  irtState: { theta: number; se: number; converged: boolean; responses: IRTResponse[] };
  questionHistory: Array<{
    question: string; type: QuestionType; difficulty: number; bloomLevel: string;
    targetConcept: string; userAnswer?: string; score?: number; correct?: boolean; reasoning?: string;
  }>;
  currentQuestion: {
    question: string; targetConcept: string; bloomLevel: string; difficulty: number;
    type: QuestionType; options?: string[]; correctAnswer?: string;
    referenceKeyPoints?: string[]; conceptContext?: string;
  } | null;
  currentChunkIndex: number;
  targetDifficulties: number[];
  complete: boolean;
}

export class VerifySession {
  public readonly sessionId: string;
  /** Unix timestamp (ms) when the session was created — used for TTL cleanup. */
  public readonly createdAt: number = Date.now();
  private readonly contentId: number;
  /** Public accessor for the knowledge ID (used by app.ts for session rehydration). */
  public readonly knowledgeId: string;
  private readonly subject: string;
  private readonly config: ResolvedConfig;
  private readonly chunks: string[];
  private readonly chunkUsageCount: number[];
  private readonly opts: GenerationOpts;

  private irtState: IRTState;
  private conceptMastery: ConceptMasteryMap = new Map();
  /** Effective max questions — raised to importantConceptCount after init(). */
  private _maxQuestions: number;
  private bloomCoverage: BloomCoverage = {}; // kept for snapshot compat
  private questionHistory: QuestionEntry[] = [];
  private _currentQuestion: GeneratedQuestion | null = null;
  private _currentChunkIndex: number = 0;
  private targetDifficulties: number[] = [];
  private _currentTarget: { conceptId: string | null; edgeDirection: 'direct' | 'incoming' | 'outgoing' } = { conceptId: null, edgeDirection: 'direct' };
  private _complete: boolean = false;

  constructor(
    contentId: number,
    knowledgeId: string,
    chunks: string[],
    subject: string,
    config: ResolvedConfig
  ) {
    this.sessionId = randomUUID();
    this.contentId = contentId;
    this.knowledgeId = knowledgeId;
    this.subject = subject;
    this.config = config;
    this._maxQuestions = config.max_questions;
    this.chunks = chunks;
    this.chunkUsageCount = new Array(chunks.length).fill(0);
    this.irtState = createIRTState();
    this.opts = {
      language: config.language,
      persona: config.persona,
      model: config.model,
    };
  }

  /** Generate the first question. Must be called after construction. */
  async init(): Promise<void> {
    // Load important concepts for the mastery loop
    const importantNodes = await getImportantConcepts(
      this.contentId, this.config.importance_threshold, MIN_IMPORTANT_CONCEPTS
    );
    for (const node of importantNodes) {
      this.conceptMastery.set(node.id, {
        conceptId: node.id,
        label: node.label,
        importance: node.importance,
        status: 'untested',
        askCount: 0,
      });
    }

    // Expand to cover all important concepts, but never exceed the preset cap
    this._maxQuestions = Math.min(
      Math.max(this._maxQuestions, importantNodes.length),
      this.config.cap_questions,
    );

    await this._generateNextQuestion();
  }

  private async _generateNextQuestion(): Promise<void> {
    const target = selectNextQuestion(this.irtState, this.conceptMastery);
    this._currentTarget = { conceptId: target.targetConceptId, edgeDirection: target.edgeDirection };
    this.targetDifficulties.push(target.b_target);

    const qType = this.pickQuestionType(target.b_target);
    const previousQuestions = this.questionHistory.map(q => q.question);
    const chunkIdx = selectChunkIndex(this.chunkUsageCount);
    this.chunkUsageCount[chunkIdx]++;
    this._currentChunkIndex = chunkIdx;

    // Store which concept is being targeted so submitAnswer can update its status
    this._currentTarget = {
      conceptId: target.targetConceptId,
      edgeDirection: target.edgeDirection,
    };

    this._currentQuestion = await generateQuestion(
      this.contentId,
      this.chunks[chunkIdx],
      target.b_target,
      previousQuestions,
      qType,
      this.opts,
      target.targetConceptId ?? undefined,
      target.edgeDirection
    );
  }

  /** Is the session still active (more questions to answer)? */
  isActive(): boolean {
    return !this._complete && this._currentQuestion !== null;
  }

  /** Get the current question formatted for the caller. */
  get importantConceptCount(): number { return this.conceptMastery.size; }
  get maxQuestions(): number { return this._maxQuestions; }

  get currentQuestion(): VerifyQuestion {
    if (!this._currentQuestion) {
      throw new PoCWError("SESSION_NOT_ACTIVE", "No current question — session may be complete");
    }
    const q = this._currentQuestion;
    return {
      text: q.question,
      number: this.questionHistory.length + 1,
      type: q.type,
      bloomLevel: q.bloomLevel,
      difficulty: q.difficulty,
      totalQuestions: this._maxQuestions,
      options: q.options,
    };
  }

  /** Submit an answer and get feedback. */
  async submitAnswer(answer: string): Promise<AnswerFeedback> {
    if (!this._currentQuestion) {
      throw new PoCWError("SESSION_NOT_ACTIVE", "No current question to answer");
    }

    const currentQ = this._currentQuestion;
    const sourceChunk = this.chunks[this._currentChunkIndex] || this.chunks[0];

    // Grade
    let gradeResult: GradeResult;
    if ((currentQ.type === "mcq" || currentQ.type === "true_false") && currentQ.correctAnswer) {
      gradeResult = gradeMCQOrTF(answer, currentQ.correctAnswer, currentQ.type);
    } else {
      gradeResult = await gradeAnswer(
        currentQ.question, answer, sourceChunk, currentQ.targetConcept, this.opts,
        currentQ.referenceKeyPoints, currentQ.conceptContext
      );
    }

    // Update concept mastery
    const targetConceptId = this._currentTarget.conceptId;
    if (targetConceptId) {
      const cm = this.conceptMastery.get(targetConceptId);
      if (cm) {
        const newAskCount = cm.askCount + 1;
        let newStatus: ConceptMastery['status'];
        if (gradeResult.correct) {
          newStatus = 'mastered';
        } else if (newAskCount >= 3) {
          newStatus = 'failed_final';
        } else {
          newStatus = 'failed';
        }
        this.conceptMastery.set(targetConceptId, { ...cm, status: newStatus, askCount: newAskCount });
      }
    }

    // Record in history
    const entry: QuestionEntry = {
      question: currentQ.question,
      type: currentQ.type,
      difficulty: currentQ.difficulty,
      bloomLevel: currentQ.bloomLevel,
      targetConcept: currentQ.targetConcept,
      userAnswer: answer,
      score: gradeResult.score,
      correct: gradeResult.correct,
      reasoning: gradeResult.reasoning,
    };
    this.questionHistory.push(entry);

    // Bloom coverage (kept for cognitive profile)
    const bl = currentQ.bloomLevel;
    this.bloomCoverage[bl] = (this.bloomCoverage[bl] ?? 0) + 1;

    // IRT update (4PL): a from contextual importance, b from the LLM's difficulty rating,
    // c from question type, d a fixed constant. (No ML predictor — see PoCW/docs/OPTIONS.md.)
    const theta_before = this.irtState.theta;

    // b ← the LLM's own per-question difficulty rating. Clamp to the IRT engine's [-2,2] range
    // and guard against NaN (a truncated-JSON parse can yield NaN), falling back to the target.
    const b = Number.isFinite(currentQ.difficulty)
      ? Math.max(-2, Math.min(2, currentQ.difficulty))
      : (this.targetDifficulties[this.questionHistory.length - 1] ?? 0);
    // c ← question type (guessing floor).
    const c = questionTypeC(currentQ.type);
    // a ← contextual importance of the target concept (KG importance, 0–1) → discrimination [0.5,2.5].
    const importance = targetConceptId
      ? this.conceptMastery.get(targetConceptId)?.importance ?? 0.5
      : 0.5;
    const a = Math.max(0.5, Math.min(2.5, 0.5 + 2.0 * importance));
    // d ← fixed upper asymptote (models ~5% slip even at high ability).
    const d = IRT_D_CONSTANT;

    this.irtState = updateAbility(
      this.irtState, b, a, c, d,
      gradeResult.correct, gradeResult.score, currentQ.bloomLevel
    );

    const irtParams = { a, b, c, d, importance, theta_before };

    const questionNumber = this.questionHistory.length;
    const progress = {
      questionNumber,
      theta: this.irtState.theta,
      se: this.irtState.se,
      bloomLevel: difficultyToBloom(this.irtState.theta),
    };

    // Stopping conditions
    const masteryComplete = isConceptMasteryComplete(this.conceptMastery, this.irtState.se);
    const isComplete = questionNumber >= this._maxQuestions
      || this.irtState.converged
      || masteryComplete;

    if (isComplete) {
      this._complete = true;
      this._currentQuestion = null;
    } else {
      await this._generateNextQuestion();
    }

    return {
      correct: gradeResult.correct,
      score: gradeResult.score,
      reasoning: gradeResult.reasoning,
      dimensions: gradeResult.dimensions,
      irtParams,
      referenceKeyPoints: currentQ.type === "open" ? currentQ.referenceKeyPoints : undefined,
      correctAnswer: (currentQ.type === "mcq" || currentQ.type === "true_false") ? currentQ.correctAnswer : undefined,
      progress,
      isComplete,
    };
  }

  /** Get the final result. Only callable after session is complete. */
  async getResult(): Promise<PoCWResult> {
    if (!this._complete) {
      throw new PoCWError("SESSION_NOT_ACTIVE", "Session has not completed yet");
    }

    const score = thetaToScore(this.irtState.theta);
    const competenceIndicator = score >= this.config.threshold * 100;
    const passed = competenceIndicator;
    const timestamp = new Date().toISOString();

    // Confidence interval: theta ± 1.96*SE mapped to 0-100
    const ciLow = thetaToScore(this.irtState.theta - 1.96 * this.irtState.se);
    const ciHigh = thetaToScore(this.irtState.theta + 1.96 * this.irtState.se);

    // Convergence: IRT estimate stable (SE < 0.40, matching SE_THRESHOLD).
    const converged = this.irtState.se < 0.40;
    // Person-fit flag: annotate when response pattern is potentially aberrant.
    const aberrant = isAberrant(this.irtState);

    // Question types used (deduplicated)
    const questionTypes = [...new Set(this.questionHistory.map(q => q.type))];

    // Look up content metadata from SQLite
    const contentRow = getContent(this.knowledgeId);
    const title = contentRow?.title || `PoCW #${this.contentId}`;
    const source = contentRow?.source || this.knowledgeId;

    const bloomLevelsReached = [...new Set(
      this.questionHistory.filter(q => q.correct).map(q => q.bloomLevel)
    )];

    const cognitiveProfile: CognitiveProfile = {
      theta: this.irtState.theta,
      se: this.irtState.se,
      score,
      questionCount: this.questionHistory.length,
      bloomLevelsReached,
      bloomCoverage: this.bloomCoverage,
      aberrant,
      passed,
      converged,
      confidenceInterval: [ciLow, ciHigh],
      questionTypes,
      title,
      source,
      oracleAddress: getOracleAddress(),
      scoreBreakdown: this.questionHistory.map(q => ({
        question: q.question,
        userAnswer: q.userAnswer ?? "",
        score: q.score || 0,
        difficulty: q.difficulty,
        bloomLevel: q.bloomLevel,
        correct: q.correct || false,
        reasoning: q.reasoning ?? "",
      })),
      contentUrl: this.knowledgeId,
      contentId: this.contentId,
      userAddress: this.subject,
      timestamp,
    };

    // Step 1: Build ERC-1155 metadata and encode as base64 data URI.
    //         The data URI is stored on-chain — no external storage needed.
    const erc1155Metadata = buildErc1155Metadata(cognitiveProfile);
    const { dataUri: tokenUri, cid: contentHash } = buildDataUri(erc1155Metadata);

    // Step 2: Save cognitive profile locally for off-chain provenance (best-effort).
    try {
      saveCognitiveProfile(cognitiveProfile);
    } catch (err) {
      console.warn("[verify-session] cognitive profile save failed:", err);
    }

    // KAL reward (100% to the learner) — computed BEFORE signing so it is bound into the
    // attestation; the controller mints exactly this amount in verifyAndMint.
    const kalAmount = passed ? calculateKAL(cognitiveProfile.scoreBreakdown) : 0;
    const kalAmountWei = kalAmount > 0 ? parseEther(kalAmount.toFixed(18)).toString() : "0";

    // Step 3: Sign the attestation with the tokenUri + kalAmount included in the payload.
    const attestation = await buildAttestation(
      this.config.attest,
      this.subject,
      this.contentId,
      score,
      kalAmountWei,
      tokenUri,
      contentHash,
      this.config.chain
    );

    // Build detailed breakdown if requested
    let response_detail: ScoreBreakdown[] | undefined;
    if (this.config.response === "detailed") {
      response_detail = this.questionHistory.map(q => ({
        question: q.question,
        type: q.type,
        score: q.score || 0,
        difficulty: q.difficulty,
        bloomLevel: q.bloomLevel,
        correct: q.correct || false,
      }));
    }

    return {
      competenceIndicator,
      score,
      theta: this.irtState.theta,
      se: this.irtState.se,
      converged: this.irtState.converged,
      confidence_interval: [ciLow, ciHigh],
      questions_asked: this.questionHistory.length,
      response_detail,
      attestation,
      knowledgeId: this.knowledgeId,
      contentId: this.contentId,
      subject: this.subject,
      timestamp,
      tokenUri,
      kalAmount: kalAmount > 0 ? kalAmount : undefined,
      disclaimers: POCW_DISCLAIMERS,
    };
  }

  /**
   * Pick question type.
   * Single-type sessions: always return that type.
   * Multi-type (mixed): difficulty-driven — T/F easy, MCQ medium, Open hard.
   */
  private pickQuestionType(b_target: number): QuestionType {
    const types = this.config.q_types;
    if (types.length === 1) return types[0];
    if (b_target < -0.5) return "true_false";
    if (b_target < 0.5)  return "mcq";
    return "open";
  }

  // ─── Serialization for Redis persistence ─────────────────────────────────

  toSnapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      contentId: this.contentId,
      knowledgeId: this.knowledgeId,
      subject: this.subject,
      config: this.config,
      chunkUsageCount: this.chunkUsageCount,
      bloomCoverage: this.bloomCoverage,
      conceptMastery: [...this.conceptMastery.entries()],
      currentTarget: this._currentTarget,
      irtState: this.irtState,
      questionHistory: this.questionHistory,
      currentQuestion: this._currentQuestion,
      currentChunkIndex: this._currentChunkIndex,
      targetDifficulties: this.targetDifficulties,
      complete: this._complete,
    };
  }

  static fromSnapshot(snap: SessionSnapshot): VerifySession {
    const session = Object.create(VerifySession.prototype) as VerifySession;
    (session as any).sessionId = snap.sessionId;
    (session as any).createdAt = snap.createdAt;
    (session as any).contentId = snap.contentId;
    (session as any).knowledgeId = snap.knowledgeId;
    (session as any).subject = snap.subject;
    (session as any).config = snap.config;
    (session as any).chunks = [];
    (session as any).chunkUsageCount = snap.chunkUsageCount;
    (session as any).bloomCoverage = snap.bloomCoverage ?? {};
    (session as any).conceptMastery = new Map(snap.conceptMastery ?? []);
    (session as any)._currentTarget = snap.currentTarget ?? { conceptId: null, edgeDirection: 'direct' };
    (session as any).opts = { language: snap.config.language, persona: snap.config.persona, model: snap.config.model };
    (session as any).irtState = snap.irtState;
    (session as any).questionHistory = snap.questionHistory;
    (session as any)._currentQuestion = snap.currentQuestion;
    (session as any)._currentChunkIndex = snap.currentChunkIndex;
    (session as any).targetDifficulties = snap.targetDifficulties;
    (session as any)._complete = snap.complete;
    return session;
  }

  /** Rehydrate chunks after loading from snapshot — called by app.ts after loadSession. */
  rehydrateChunks(chunks: string[]): void {
    (this as any).chunks = chunks;
  }
}

// ─── KAL calculation ─────────────────────────────────────────────────────────

const BASE_KAL = 100;
const DEFAULT_M  = 1.0;

function calculateKAL(
  breakdown: Array<{ score: number; bloomLevel: string }>,
  M: number = DEFAULT_M
): number {
  let numerator   = 0;
  let denominator = 0;
  for (const q of breakdown) {
    const w = BLOOM_WEIGHTS[q.bloomLevel] ?? 0.25;
    numerator   += q.score * w;
    denominator += 100    * w;
  }
  if (denominator === 0) return 0;
  const normalised = numerator / denominator;
  return Math.round(BASE_KAL * M * normalised * 100) / 100;
}
