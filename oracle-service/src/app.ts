import express, { Request, Response } from "express";
import { signResult, getOracleAddress } from "./services/signer";
import {
  createSession,
  submitAnswer,
  getSessionResult,
  getSession
} from "./services/session-manager";

const app = express();
app.use(express.json());

function isValidEthereumAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function isValidContentUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  if (url.startsWith("ipfs://")) return url.length > 7;
  try { new URL(url); return true; } catch { return false; }
}

const MAX_ANSWER_LENGTH = 50_000; // 50KB

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Internal server error";
}

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
  if (!isValidEthereumAddress(userAddress)) {
    return res.status(400).json({ error: "Invalid Ethereum address format" });
  }
  if (!isValidContentUrl(contentUrl)) {
    return res.status(400).json({ error: "Invalid content URL" });
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
  } catch (err: unknown) {
    return res.status(500).json({ error: errorMessage(err) });
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
  if (answer.length === 0 || answer.length > MAX_ANSWER_LENGTH) {
    return res.status(400).json({ error: `Answer must be 1-${MAX_ANSWER_LENGTH} characters` });
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
  } catch (err: unknown) {
    return res.status(500).json({ error: errorMessage(err) });
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
  if (!isValidEthereumAddress(userAddress)) {
    return res.status(400).json({ error: "Invalid Ethereum address format" });
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
  } catch (err: unknown) {
    return res.status(500).json({ error: errorMessage(err) });
  }
});

export default app;
