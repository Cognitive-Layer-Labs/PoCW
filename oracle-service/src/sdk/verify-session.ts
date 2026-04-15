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
  selectNextDifficulty,
  thetaToScore,
  difficultyToBloom,
  IRTState,
} from "../services/irt-engine";
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

/** Snapshot shape for Redis persistence (WS3). */
export interface SessionSnapshot {
  sessionId: string;
  createdAt: number;
  contentId: number;
  knowledgeId: string;
  subject: string;
  config: ResolvedConfig;
  chunkUsageCount: number[];
  irtState: { theta: number; se: number; converged: boolean; responses: Array<{ difficulty: number; correct: boolean; score: number; bloomLevel: string }> };
  questionHistory: Array<{
    question: string; type: QuestionType; difficulty: number; bloomLevel: string;
    targetConcept: string; userAnswer?: string; score?: number; correct?: boolean; reasoning?: string;
  }>;
  currentQuestion: {
    question: string; targetConcept: string; bloomLevel: string; difficulty: number;
    type: QuestionType; options?: string[]; correctAnswer?: string;
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
  private questionHistory: QuestionEntry[] = [];
  private _currentQuestion: GeneratedQuestion | null = null;
  private _currentChunkIndex: number = 0;
  private targetDifficulties: number[] = [];
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
    const startDifficulty = configDifficultyToIRT(this.config.difficulty);
    const chunkIdx = selectChunkIndex(this.chunkUsageCount);
    this.chunkUsageCount[chunkIdx]++;
    this._currentChunkIndex = chunkIdx;
    this.targetDifficulties.push(startDifficulty);

    const qType = this.pickQuestionType();
    this._currentQuestion = await generateQuestion(
      this.contentId,
      this.chunks[chunkIdx],
      startDifficulty,
      [],
      qType,
      this.opts
    );
  }

  /** Is the session still active (more questions to answer)? */
  isActive(): boolean {
    return !this._complete && this._currentQuestion !== null;
  }

  /** Get the current question formatted for the caller. */
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
      totalQuestions: this.config.max_questions,
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

    // Grade based on question type
    let gradeResult: GradeResult;
    if ((currentQ.type === "mcq" || currentQ.type === "true_false") && currentQ.correctAnswer) {
      gradeResult = gradeMCQOrTF(answer, currentQ.correctAnswer, currentQ.type);
    } else {
      gradeResult = await gradeAnswer(
        currentQ.question, answer, sourceChunk, currentQ.targetConcept, this.opts
      );
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

    // Update IRT using the target difficulty we computed (not LLM's)
    const qIndex = this.questionHistory.length - 1;
    const targetDifficulty = this.targetDifficulties[qIndex] ?? 0;
    this.irtState = updateAbility(
      this.irtState,
      targetDifficulty,
      gradeResult.correct,
      gradeResult.score,
      currentQ.bloomLevel
    );

    const questionNumber = this.questionHistory.length;
    const progress = {
      questionNumber,
      theta: this.irtState.theta,
      se: this.irtState.se,
      bloomLevel: difficultyToBloom(this.irtState.theta),
    };

    // Check completion: config max_questions OR IRT convergence
    const isComplete = questionNumber >= this.config.max_questions || this.irtState.converged;

    if (isComplete) {
      this._complete = true;
      this._currentQuestion = null;
    } else {
      // Generate next question
      const nextDifficulty = selectNextDifficulty(this.irtState);
      this.targetDifficulties.push(nextDifficulty);

      const previousQuestions = this.questionHistory.map(q => q.question);
      const nextChunkIdx = selectChunkIndex(this.chunkUsageCount);
      this.chunkUsageCount[nextChunkIdx]++;
      this._currentChunkIndex = nextChunkIdx;

      const qType = this.pickQuestionType();
      this._currentQuestion = await generateQuestion(
        this.contentId,
        this.chunks[nextChunkIdx],
        nextDifficulty,
        previousQuestions,
        qType,
        this.opts
      );
    }

    return {
      correct: gradeResult.correct,
      score: gradeResult.score,
      reasoning: gradeResult.reasoning,
      dimensions: gradeResult.dimensions,
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

    // Convergence: IRT estimate is stable when SE < 0.4
    const converged = this.irtState.se < 0.4;

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
      passed,
      converged,
      confidenceInterval: [ciLow, ciHigh],
      questionTypes,
      title,
      source,
      oracleAddress: getOracleAddress(),
      scoreBreakdown: this.questionHistory.map(q => ({
        question: q.question,
        score: q.score || 0,
        difficulty: q.difficulty,
        bloomLevel: q.bloomLevel,
        correct: q.correct || false,
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

    // Step 3: Sign the attestation with the tokenUri included in the payload.
    const attestation = await buildAttestation(
      this.config.attest,
      this.subject,
      this.contentId,
      score,
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
      disclaimers: POCW_DISCLAIMERS,
    };
  }

  /** Randomly pick a question type from the configured types. */
  private pickQuestionType(): QuestionType {
    const types = this.config.q_types;
    return types[Math.floor(Math.random() * types.length)];
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
    (session as any).chunks = []; // reloaded from contentCache on demand
    (session as any).chunkUsageCount = snap.chunkUsageCount;
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
