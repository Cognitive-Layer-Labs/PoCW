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
  thetaToScore,
  difficultyToBloom,
  isAberrant,
  questionTypeC,
  difficultyOffset,
  anchorItemDifficulty,
  IRTState,
  IRTResponse,
  ConceptMastery,
  ConceptMasteryMap,
  BloomCoverage,
  MIN_IMPORTANT_CONCEPTS,
} from "../services/irt-engine";
import { getImportantConcepts } from "../services/kg-store";
import {
  generateQuestion,
  gradeAnswer,
  gradeMCQOrTF,
  GeneratedQuestion,
  GradeResult,
  QuestionGenerationError,
} from "../services/question-generator";
import { selectChunkIndex, chunksMentioning } from "../services/session-manager";
import { getContent } from "./content-store";
import {
  ResolvedConfig,
  QuestionType,
  VerifyQuestion,
  AnswerFeedback,
  PoCWResult,
  ScoreBreakdown,
  ConceptOutcome,
  GenerationOpts,
  PoCWError,
  POCW_DISCLAIMERS,
} from "./types";

/** Fixed 4PL upper asymptote: P(correct) reaches 1.0 at high ability (keeps the
 *  (theta+2)/4*100 score projection self-consistent). */
const IRT_D_CONSTANT = 1.0;

/**
 * Difficulty each question type is best suited to (IRT b). Mixed sessions pick the allowed type
 * whose centre is nearest the item's b_target (ties go to the harder type). With all three types
 * allowed this gives b < −0.5 → true_false, −0.5 ≤ b < 0.5 → mcq, b ≥ 0.5 → open; with a subset
 * the bands simply merge (e.g. mcq+true_false: TF below −0.5, MCQ above; open+true_false: TF below 0).
 */
const TYPE_DIFFICULTY_CENTRE: Record<QuestionType, number> = {
  true_false: -1.0,
  mcq: 0.0,
  open: 1.0,
};

/**
 * Allowed question types for an item target, best first (nearest TYPE_DIFFICULTY_CENTRE, ties to
 * the harder type). Only ever contains types from `allowed`; the tail is the fallback order used
 * when generating the preferred type fails.
 */
export function rankQuestionTypes(b_target: number, allowed: readonly QuestionType[]): QuestionType[] {
  const types = [...new Set(allowed)].filter(t => t in TYPE_DIFFICULTY_CENTRE);
  return types.sort((x, y) => {
    const dx = Math.abs(b_target - TYPE_DIFFICULTY_CENTRE[x]);
    const dy = Math.abs(b_target - TYPE_DIFFICULTY_CENTRE[y]);
    return dx - dy || TYPE_DIFFICULTY_CENTRE[y] - TYPE_DIFFICULTY_CENTRE[x];
  });
}

/** Question type for an item target — always one of `allowed` (see rankQuestionTypes). */
export function pickQuestionType(b_target: number, allowed: readonly QuestionType[]): QuestionType {
  const ranked = rankQuestionTypes(b_target, allowed);
  if (ranked.length === 0) throw new PoCWError("INVALID_CONFIG", "q_types must contain at least one valid type");
  return ranked[0];
}

interface QuestionEntry {
  question: string;
  type: QuestionType;
  difficulty: number;
  bloomLevel: string;
  targetConcept: string;
  /** KG concept id this question was tied to (null when unknown). Absent in pre-upgrade snapshots. */
  conceptId?: string | null;
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
    targetConcept: string; conceptId?: string | null;
    userAnswer?: string; score?: number; correct?: boolean; reasoning?: string;
  }>;
  currentQuestion: {
    question: string; targetConcept: string; bloomLevel: string; difficulty: number;
    type: QuestionType; options?: string[]; correctAnswer?: string;
    referenceKeyPoints?: string[]; conceptContext?: string;
  } | null;
  currentChunkIndex: number;
  targetDifficulties: number[];
  /** Number of questions in the session (absent in pre-upgrade snapshots → config.max_questions). */
  maxQuestions?: number;
  complete: boolean;
  /** Final result, frozen on first getResult() so repeated fetches are identical. */
  result?: PoCWResult | null;
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
  /** Exact number of questions in the session (= config.max_questions; never expanded). */
  private _maxQuestions: number;
  private bloomCoverage: BloomCoverage = {};
  private questionHistory: QuestionEntry[] = [];
  private _currentQuestion: GeneratedQuestion | null = null;
  private _currentChunkIndex: number = 0;
  private targetDifficulties: number[] = [];
  private _currentTarget: { conceptId: string | null; edgeDirection: 'direct' | 'incoming' | 'outgoing' } = { conceptId: null, edgeDirection: 'direct' };
  private _complete: boolean = false;
  private _result: PoCWResult | null = null;

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

    // The session length is exactly max_questions — it is never expanded to cover every important
    // concept. When there are more concepts than questions, the mastery loop asks the most
    // important ones first (selectNextQuestion), so the least important may go untested.
    await this._generateNextQuestion();
  }

  private async _generateNextQuestion(): Promise<void> {
    const target = selectNextQuestion(
      this.irtState, this.conceptMastery, difficultyOffset(this.config.difficulty),
    );
    // Store which concept is being targeted so submitAnswer can update its status
    this._currentTarget = { conceptId: target.targetConceptId, edgeDirection: target.edgeDirection };

    const previousQuestions = this.questionHistory.map(q => q.question);
    // Source passage: a least-used chunk that mentions the targeted concept (long books have
    // hundreds of chunks, most of which say nothing about a given concept); any chunk otherwise.
    const label = target.targetConceptId ? this.conceptMastery.get(target.targetConceptId)?.label : undefined;
    const chunkIdx = selectChunkIndex(this.chunkUsageCount, chunksMentioning(this.chunks, label));
    this.chunkUsageCount[chunkIdx]++;
    this._currentChunkIndex = chunkIdx;

    // Preferred type first; if its generator gives up, fall back to the next *allowed* type
    // (never to a type outside config.q_types).
    let lastError: unknown;
    for (const qType of rankQuestionTypes(target.b_target, this.config.q_types)) {
      try {
        const question = await generateQuestion(
          this.contentId,
          this.chunks[chunkIdx],
          target.b_target,
          previousQuestions,
          qType,
          this.opts,
          target.targetConceptId ?? undefined,
          target.edgeDirection
        );
        // b used by the IRT update (and shown to the caller): LLM rating anchored to the target.
        question.difficulty = anchorItemDifficulty(question.difficulty, target.b_target);
        // Pushed only on success so targetDifficulties[i] always belongs to question i.
        this.targetDifficulties.push(target.b_target);
        this._currentQuestion = question;
        return;
      } catch (err) {
        if (!(err instanceof QuestionGenerationError)) throw err;
        lastError = err;
        console.warn(`[verify-session] ${qType} generation failed, trying next allowed type: ${err.message}`);
      }
    }
    throw lastError ?? new PoCWError("INVALID_CONFIG", "q_types must contain at least one valid type");
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

    // b ← the LLM's per-question difficulty rating, anchored to the target this question was
    // generated for (±0.25, see anchorItemDifficulty; NaN/missing → the target).
    // Already applied at generation time; repeated here for snapshots taken before that (idempotent).
    const itemTarget = this.targetDifficulties[this.questionHistory.length];
    const b = typeof itemTarget === "number"
      ? anchorItemDifficulty(currentQ.difficulty, itemTarget)
      : (Number.isFinite(currentQ.difficulty) ? Math.max(-2, Math.min(2, currentQ.difficulty)) : 0);

    // Record in history
    const entry: QuestionEntry = {
      question: currentQ.question,
      type: currentQ.type,
      difficulty: b,
      bloomLevel: currentQ.bloomLevel,
      targetConcept: currentQ.targetConcept,
      conceptId: targetConceptId ?? this.resolveConceptIdByLabel(currentQ.targetConcept),
      userAnswer: answer,
      score: gradeResult.score,
      correct: gradeResult.correct,
      reasoning: gradeResult.reasoning,
    };
    this.questionHistory.push(entry);

    // Bloom coverage (part of the result profile)
    const bl = currentQ.bloomLevel;
    this.bloomCoverage[bl] = (this.bloomCoverage[bl] ?? 0) + 1;

    // IRT update (4PL): a from contextual importance, b from the anchored LLM difficulty rating
    // (above), c from question type, d a fixed constant. (No ML predictor — see docs/OPTIONS.md.)
    const theta_before = this.irtState.theta;

    // c ← question type (guessing floor).
    const c = questionTypeC(currentQ.type);
    // a ← contextual importance of the target concept (KG importance, 0–1) → discrimination [0.5,2.5].
    const importance = targetConceptId
      ? this.conceptMastery.get(targetConceptId)?.importance ?? 0.5
      : 0.5;
    const a = Math.max(0.5, Math.min(2.5, 0.5 + 2.0 * importance));
    // d ← fixed upper asymptote (1.0: P(correct)→1 at high ability).
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

    // The session is fixed-length: it ends after exactly maxQuestions answers. IRT convergence
    // and concept mastery are reported in the result but never stop the session early, so the
    // number of questions always matches totalQuestions / maxQuestions.
    const isComplete = questionNumber >= this._maxQuestions;

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

  /** Is the session complete (all questions answered)? */
  isComplete(): boolean {
    return this._complete;
  }

  /**
   * Get the final result. Only callable after session is complete.
   * The result is computed once and then frozen (stable across repeated calls/snapshots).
   */
  async getResult(): Promise<PoCWResult> {
    if (!this._complete) {
      throw new PoCWError("SESSION_NOT_ACTIVE", "Session has not completed yet");
    }
    if (!this._result) this._result = this.computeResult();
    return this._result;
  }

  private computeResult(): PoCWResult {

    const score = thetaToScore(this.irtState.theta);
    const competenceIndicator = score >= this.config.threshold * 100;
    const timestamp = new Date().toISOString();

    // Confidence interval: theta ± 1.96*SE mapped to 0-100
    const ciLow = thetaToScore(this.irtState.theta - 1.96 * this.irtState.se);
    const ciHigh = thetaToScore(this.irtState.theta + 1.96 * this.irtState.se);

    // Look up content metadata from SQLite
    const contentRow = getContent(this.knowledgeId);

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
        conceptId: this.conceptIdOf(q),
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
      concepts: this.buildConceptOutcomes(),
      profile: {
        title: contentRow?.title || `PoCW #${this.contentId}`,
        source: contentRow?.source || this.knowledgeId,
        bloomLevelsReached: [...new Set(
          this.questionHistory.filter(q => q.correct).map(q => q.bloomLevel)
        )],
        bloomCoverage: { ...this.bloomCoverage },
        aberrant: isAberrant(this.irtState),
        questionTypes: [...new Set(this.questionHistory.map(q => q.type))],
      },
      knowledgeId: this.knowledgeId,
      contentId: this.contentId,
      subject: this.subject,
      timestamp,
      disclaimers: POCW_DISCLAIMERS,
    };
  }

  /**
   * Per-concept outcomes for every important concept tracked by the mastery loop
   * (label from the KG node), in importance order. Counts come from the question history.
   */
  private buildConceptOutcomes(): ConceptOutcome[] {
    const stats = new Map<string, { asked: number; correct: number }>();
    for (const q of this.questionHistory) {
      const id = this.conceptIdOf(q);
      if (!id) continue;
      const s = stats.get(id) ?? { asked: 0, correct: 0 };
      s.asked++;
      if (q.correct) s.correct++;
      stats.set(id, s);
    }
    return [...this.conceptMastery.values()]
      .sort((x, y) => y.importance - x.importance)
      .map(cm => {
        const s = stats.get(cm.conceptId) ?? { asked: 0, correct: 0 };
        return {
          id: cm.conceptId,
          label: cm.label,
          asked: s.asked,
          correct: s.correct,
          mastered: cm.status === "mastered",
        };
      });
  }

  /** Concept id for a history entry (falls back to label matching for older snapshots). */
  private conceptIdOf(q: QuestionEntry): string | null {
    if (q.conceptId !== undefined) return q.conceptId;
    return this.resolveConceptIdByLabel(q.targetConcept);
  }

  /**
   * Map an LLM-reported target concept (label or id) to a tracked KG concept id.
   * Used when the question was not explicitly targeted (Fisher-information mode).
   */
  private resolveConceptIdByLabel(target: string | undefined): string | null {
    if (!target) return null;
    if (this.conceptMastery.has(target)) return target;
    const norm = target.trim().toLowerCase();
    for (const cm of this.conceptMastery.values()) {
      if (cm.label.trim().toLowerCase() === norm) return cm.conceptId;
    }
    return null;
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
      maxQuestions: this._maxQuestions,
      complete: this._complete,
      result: this._result,
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
    // JSON turns the initial se (Infinity) into null — restore it.
    (session as any).irtState = {
      ...snap.irtState,
      se: typeof snap.irtState.se === "number" ? snap.irtState.se : Infinity,
    };
    (session as any).questionHistory = snap.questionHistory;
    (session as any)._currentQuestion = snap.currentQuestion;
    (session as any)._currentChunkIndex = snap.currentChunkIndex;
    (session as any).targetDifficulties = snap.targetDifficulties;
    // Pre-upgrade snapshots lack maxQuestions: use the configured count (never below the
    // number of the question already on screen).
    (session as any)._maxQuestions = typeof snap.maxQuestions === "number"
      ? snap.maxQuestions
      : Math.max(
          snap.config.max_questions,
          (snap.questionHistory?.length ?? 0) + (snap.currentQuestion && !snap.complete ? 1 : 0),
        );
    (session as any)._complete = snap.complete;
    (session as any)._result = snap.result ?? null;
    return session;
  }

  /** Rehydrate chunks after loading from snapshot — called by app.ts after loadSession. */
  rehydrateChunks(chunks: string[]): void {
    (this as any).chunks = chunks;
    // The text pipeline can change between engine versions (e.g. a re-parse after an upgrade);
    // keep the usage counters aligned with the chunks actually available.
    const usage = this.chunkUsageCount;
    if (usage.length !== chunks.length) {
      usage.length = chunks.length;
      for (let i = 0; i < usage.length; i++) usage[i] = usage[i] ?? 0;
      if (this._currentChunkIndex >= chunks.length) this._currentChunkIndex = 0;
    }
  }
}
