/**
 * Adaptive Session Manager
 *
 * Orchestrates the adaptive testing loop:
 *   createSession → (submitAnswer → next question) × N → converged → getResult
 *
 * Wires together: Parser, KG Builder, KG Store, IRT Engine, KAQG Generator, IPFS Store.
 */

import { randomUUID } from "crypto";
import { parseContentToText, chunkText } from "./parser";
import { extractKnowledgeGraph } from "./kg-builder";
import { storeGraph, graphExists } from "./kg-store";
import {
  createIRTState,
  updateAbility,
  selectNextDifficulty,
  isConverged,
  thetaToScore,
  difficultyToBloom,
  IRTState
} from "./irt-engine";
import { generateSingleQuestion, gradeAnswer, GeneratedQuestion, GradeResult } from "./question-generator";
import { uploadCognitiveProfile, CognitiveProfile } from "./ipfs-store";

export interface QuestionEntry {
  question: string;
  difficulty: number;
  bloomLevel: string;
  targetConcept: string;
  userAnswer?: string;
  score?: number;
  correct?: boolean;
  reasoning?: string;
}

export interface AdaptiveSession {
  sessionId: string;
  contentId: number;
  contentUrl: string;
  userAddress: string;
  contentText: string;
  chunks: string[];              // overlapping text chunks from the document
  chunkUsageCount: number[];     // how many questions were sourced from each chunk
  irtState: IRTState;
  questionHistory: QuestionEntry[];
  currentQuestion: GeneratedQuestion | null;
  currentChunkIndex: number;     // which chunk sourced the current question
  status: "active" | "converged" | "completed";
  createdAt: number;
  _targetDifficulties: number[]; // IRT-computed target difficulties per question
}

const sessions = new Map<string, AdaptiveSession>();

/**
 * Select a chunk index weighted toward least-used chunks.
 */
function selectChunkIndex(chunkUsageCount: number[]): number {
  const maxUsage = Math.max(...chunkUsageCount);
  // Weight = (maxUsage + 1 - usage) so unused chunks have highest weight
  const weights = chunkUsageCount.map(u => maxUsage + 1 - u);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * totalWeight;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/** Max chunks to use for KG building to limit LLM cost */
const MAX_KG_CHUNKS = 15;

/**
 * Create a new adaptive session.
 * Parses content, chunks it, builds KG from sampled chunks, generates first question.
 */
export async function createSession(
  contentUrl: string,
  userAddress: string
): Promise<{ sessionId: string; contentId: number; question: GeneratedQuestion }> {
  const contentText = await parseContentToText(contentUrl);
  const contentId = Date.now();

  // Split into overlapping chunks
  const chunks = chunkText(contentText);

  // Build KG from sampled chunks (cap at MAX_KG_CHUNKS evenly spaced)
  if (!(await graphExists(contentId))) {
    let sampled: string[];
    if (chunks.length <= MAX_KG_CHUNKS) {
      sampled = chunks;
    } else {
      const step = chunks.length / MAX_KG_CHUNKS;
      sampled = Array.from({ length: MAX_KG_CHUNKS }, (_, i) =>
        chunks[Math.min(Math.floor(i * step), chunks.length - 1)]
      );
    }
    // Build KG from each sampled chunk (they'll merge into the same contentId graph)
    for (const chunk of sampled) {
      const graph = await extractKnowledgeGraph(contentId, chunk);
      await storeGraph(graph);
    }
  }

  const irtState = createIRTState();
  const chunkUsageCount = new Array(chunks.length).fill(0);

  // First question: medium difficulty (θ = 0 → Apply level), from a random chunk
  const firstDifficulty = 0;
  const firstChunkIdx = selectChunkIndex(chunkUsageCount);
  chunkUsageCount[firstChunkIdx]++;

  const firstQuestion = await generateSingleQuestion(
    contentId,
    chunks[firstChunkIdx],
    firstDifficulty,
    []
  );

  const session: AdaptiveSession = {
    sessionId: randomUUID(),
    contentId,
    contentUrl,
    userAddress,
    contentText,
    chunks,
    chunkUsageCount,
    irtState,
    questionHistory: [],
    currentQuestion: firstQuestion,
    currentChunkIndex: firstChunkIdx,
    status: "active",
    createdAt: Date.now(),
    _targetDifficulties: [firstDifficulty]
  };

  sessions.set(session.sessionId, session);

  return {
    sessionId: session.sessionId,
    contentId,
    question: firstQuestion
  };
}

export interface AnswerResult {
  status: "next" | "converged";
  gradeResult: GradeResult;
  nextQuestion?: GeneratedQuestion;
  progress: {
    questionNumber: number;
    currentTheta: number;
    currentSE: number;
    bloomLevel: string;
  };
}

/**
 * Submit an answer for the current question.
 * Grades the answer, updates IRT state, and either generates the next
 * question or signals convergence.
 */
export async function submitAnswer(
  sessionId: string,
  answer: string
): Promise<AnswerResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.status !== "active") throw new Error("Session is not active");
  if (!session.currentQuestion) throw new Error("No current question");

  const currentQ = session.currentQuestion;

  // Grade the answer using the chunk that sourced this question
  const sourceChunk = session.chunks[session.currentChunkIndex] || session.contentText;
  const gradeResult = await gradeAnswer(
    currentQ.question,
    answer,
    sourceChunk,
    currentQ.targetConcept
  );

  // Record in history
  const entry: QuestionEntry = {
    question: currentQ.question,
    difficulty: currentQ.difficulty,
    bloomLevel: currentQ.bloomLevel,
    targetConcept: currentQ.targetConcept,
    userAnswer: answer,
    score: gradeResult.score,
    correct: gradeResult.correct,
    reasoning: gradeResult.reasoning
  };
  session.questionHistory.push(entry);

  // Use the IRT-computed target difficulty (from selectNextDifficulty),
  // NOT the LLM's self-reported difficulty which is unreliable.
  const qIndex = session.questionHistory.length - 1;
  const targetDifficulty = session._targetDifficulties?.[qIndex] ?? 0;
  session.irtState = updateAbility(
    session.irtState,
    targetDifficulty,
    gradeResult.correct,
    gradeResult.score,
    currentQ.bloomLevel
  );

  const questionNumber = session.questionHistory.length;
  const progress = {
    questionNumber,
    currentTheta: session.irtState.theta,
    currentSE: session.irtState.se,
    bloomLevel: difficultyToBloom(session.irtState.theta)
  };

  if (isConverged(session.irtState)) {
    session.status = "converged";
    session.currentQuestion = null;
    return { status: "converged", gradeResult, progress };
  }

  // Generate next question from a new chunk
  const nextDifficulty = selectNextDifficulty(session.irtState);
  const previousQuestions = session.questionHistory.map(q => q.question);

  const nextChunkIdx = selectChunkIndex(session.chunkUsageCount);
  session.chunkUsageCount[nextChunkIdx]++;

  const nextQuestion = await generateSingleQuestion(
    session.contentId,
    session.chunks[nextChunkIdx],
    nextDifficulty,
    previousQuestions
  );

  session._targetDifficulties.push(nextDifficulty);
  session.currentQuestion = nextQuestion;
  session.currentChunkIndex = nextChunkIdx;

  return {
    status: "next",
    gradeResult,
    nextQuestion,
    progress
  };
}

/**
 * Get the final result of a converged session.
 * Builds cognitive profile and uploads to IPFS (mock).
 */
export async function getSessionResult(
  sessionId: string
): Promise<{
  score: number;
  theta: number;
  cognitiveProfile: CognitiveProfile;
  ipfsHash: string;
  contentId: number;
}> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.status !== "converged" && session.status !== "completed") {
    throw new Error("Session has not converged yet");
  }

  const score = thetaToScore(session.irtState.theta);

  // Determine Bloom's levels reached
  const bloomLevelsReached = [...new Set(
    session.questionHistory
      .filter(q => q.correct)
      .map(q => q.bloomLevel)
  )];

  const cognitiveProfile: CognitiveProfile = {
    theta: session.irtState.theta,
    se: session.irtState.se,
    score,
    questionCount: session.questionHistory.length,
    bloomLevelsReached,
    scoreBreakdown: session.questionHistory.map(q => ({
      question: q.question,
      score: q.score || 0,
      difficulty: q.difficulty,
      bloomLevel: q.bloomLevel,
      correct: q.correct || false
    })),
    contentUrl: session.contentUrl,
    contentId: session.contentId,
    userAddress: session.userAddress,
    timestamp: new Date().toISOString()
  };

  const ipfsHash = await uploadCognitiveProfile(cognitiveProfile);
  session.status = "completed";

  return { score, theta: session.irtState.theta, cognitiveProfile, ipfsHash, contentId: session.contentId };
}

/**
 * Get a session by ID (for API validation).
 */
export function getSession(sessionId: string): AdaptiveSession | undefined {
  return sessions.get(sessionId);
}

/** For testing: clear all sessions */
export function __clearSessionsForTest(): void {
  sessions.clear();
}
