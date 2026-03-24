import express, { Request, Response } from "express";
import { Challenge, generateChallenge, recordAnswers, verifyChallenge } from "./services/ai-engine";
import { signResult, getOracleAddress } from "./services/signer";
import {
  createSession,
  submitAnswer,
  getSessionResult,
  getSession
} from "./services/session-manager";

const app = express();
app.use(express.json());

const challenges = new Map<string, Challenge>();

/* ============================================================
 * Legacy endpoints (backward compatible)
 * ============================================================ */

app.post("/generate-challenge", async (req: Request, res: Response) => {
  const { contentUrl, userAddress } = req.body || {};
  if (!contentUrl || !userAddress) {
    return res.status(400).json({ error: "contentUrl and userAddress required" });
  }

  try {
    const challenge = await generateChallenge(contentUrl, userAddress);
    challenges.set(challenge.challengeId, challenge);
    return res.json({
      challengeId: challenge.challengeId,
      contentId: challenge.contentId,
      questions: challenge.questions
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/submit-challenge", async (req: Request, res: Response) => {
  const { challengeId, userAnswers, userAddress } = req.body || {};
  if (!challengeId || !userAddress || !Array.isArray(userAnswers)) {
    return res
      .status(400)
      .json({ error: "challengeId, userAddress and userAnswers[] required" });
  }

  const challenge = challenges.get(challengeId);
  if (!challenge) {
    return res.status(404).json({ error: "challenge not found" });
  }
  if (challenge.userAddress.toLowerCase() !== String(userAddress).toLowerCase()) {
    return res.status(403).json({ error: "user mismatch" });
  }

  try {
    recordAnswers(challengeId, userAnswers);
    const score = await verifyChallenge(challengeId);
    const signature = await signResult(challenge.userAddress, challenge.contentId, score);
    return res.json({
      status: "success",
      score,
      signature,
      contentId: challenge.contentId,
      oracle: getOracleAddress()
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
 * Adaptive Testing endpoints (KAQG + IRT)
 * ============================================================ */

/**
 * Start a new adaptive session.
 * POST /api/session/start { contentUrl, userAddress }
 */
app.post("/api/session/start", async (req: Request, res: Response) => {
  const { contentUrl, userAddress } = req.body || {};
  if (!contentUrl || !userAddress) {
    return res.status(400).json({ error: "contentUrl and userAddress required" });
  }

  try {
    const result = await createSession(contentUrl, userAddress);
    return res.json({
      sessionId: result.sessionId,
      contentId: result.contentId,
      question: {
        text: result.question.question,
        questionNumber: 1,
        bloomLevel: result.question.bloomLevel
      }
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Submit an answer to the current question.
 * POST /api/session/answer { sessionId, answer }
 */
app.post("/api/session/answer", async (req: Request, res: Response) => {
  const { sessionId, answer } = req.body || {};
  if (!sessionId || typeof answer !== "string") {
    return res.status(400).json({ error: "sessionId and answer required" });
  }

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: "session not found" });
  }

  try {
    const result = await submitAnswer(sessionId, answer);

    if (result.status === "converged") {
      return res.json({
        status: "converged",
        gradeResult: result.gradeResult,
        progress: result.progress
      });
    }

    return res.json({
      status: "next",
      gradeResult: result.gradeResult,
      question: {
        text: result.nextQuestion!.question,
        questionNumber: result.progress.questionNumber + 1,
        bloomLevel: result.nextQuestion!.bloomLevel
      },
      progress: result.progress
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get final result of a converged session.
 * POST /api/session/result { sessionId, userAddress }
 */
app.post("/api/session/result", async (req: Request, res: Response) => {
  const { sessionId, userAddress } = req.body || {};
  if (!sessionId || !userAddress) {
    return res.status(400).json({ error: "sessionId and userAddress required" });
  }

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: "session not found" });
  }
  if (session.userAddress.toLowerCase() !== String(userAddress).toLowerCase()) {
    return res.status(403).json({ error: "user mismatch" });
  }

  try {
    const result = await getSessionResult(sessionId);
    const signature = await signResult(userAddress, result.contentId, result.score);

    return res.json({
      status: "success",
      score: result.score,
      theta: result.theta,
      cognitiveProfile: result.cognitiveProfile,
      ipfsHash: result.ipfsHash,
      signature,
      contentId: result.contentId,
      oracle: getOracleAddress()
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default app;

