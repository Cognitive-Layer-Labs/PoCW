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
import { uploadCognitiveProfile, CognitiveProfile } from "../services/ipfs-store";
import { buildAttestation } from "./attestation";
import {
  ResolvedConfig,
  QuestionType,
  VerifyQuestion,
  AnswerFeedback,
  PoCWResult,
  ScoreBreakdown,
  GenerationOpts,
  PoCWError,
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

export class VerifySession {
  public readonly sessionId: string;
  private readonly contentId: number;
  private readonly knowledgeId: string;
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
    const passed = score >= this.config.threshold * 100;

    // Confidence interval: theta ± 1.96*SE mapped to 0-100
    const ciLow = thetaToScore(this.irtState.theta - 1.96 * this.irtState.se);
    const ciHigh = thetaToScore(this.irtState.theta + 1.96 * this.irtState.se);

    // Attestation
    const attestation = await buildAttestation(
      this.config.attest,
      this.subject,
      this.contentId,
      score,
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

    // Upload cognitive profile (mock IPFS)
    const bloomLevelsReached = [...new Set(
      this.questionHistory.filter(q => q.correct).map(q => q.bloomLevel)
    )];

    const cognitiveProfile: CognitiveProfile = {
      theta: this.irtState.theta,
      se: this.irtState.se,
      score,
      questionCount: this.questionHistory.length,
      bloomLevelsReached,
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
      timestamp: new Date().toISOString(),
    };
    await uploadCognitiveProfile(cognitiveProfile);

    return {
      passed,
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
      timestamp: new Date().toISOString(),
    };
  }

  /** Randomly pick a question type from the configured types. */
  private pickQuestionType(): QuestionType {
    const types = this.config.q_types;
    return types[Math.floor(Math.random() * types.length)];
  }
}
