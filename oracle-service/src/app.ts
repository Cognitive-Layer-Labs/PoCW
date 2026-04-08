import express, { Request, Response } from "express";
import { PoCW } from "./sdk/index";
import { VerifySession } from "./sdk/verify-session";
import { PoCWError, PoCWErrorCode } from "./sdk/types";

const app = express();
app.use(express.json());

// Shared PoCW instance (initialized by server.ts)
let pocw: PoCW | null = null;

export function setPoCWInstance(instance: PoCW): void {
  pocw = instance;
}

function getPoCW(): PoCW {
  if (!pocw) throw new PoCWError("INVALID_CONFIG", "PoCW not initialized");
  return pocw;
}

// Active verify sessions (keyed by sessionId)
const verifySessions = new Map<string, VerifySession>();

const MAX_ANSWER_LENGTH = 50_000;

// ─── Error Mapping ───────────────────────────────────────────────────────────

const HTTP_STATUS: Record<PoCWErrorCode, number> = {
  CONTENT_NOT_FOUND: 404,
  INDEXING_IN_PROGRESS: 202,
  INDEXING_FAILED: 422,
  INVALID_CONFIG: 400,
  SESSION_EXPIRED: 410,
  SESSION_NOT_ACTIVE: 409,
  LLM_ERROR: 503,
  GRAPH_DB_ERROR: 503,
  ATTESTATION_ERROR: 500,
  CAPACITY_EXCEEDED: 429,
};

function sendError(res: Response, err: unknown): void {
  if (err instanceof PoCWError) {
    const status = HTTP_STATUS[err.code] || 500;
    const payload: any = { error: err.message, code: err.code };
    if (err.code === "INDEXING_IN_PROGRESS") {
      res.set("Retry-After", "5");
    }
    res.status(status).json(payload);
  } else {
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ error: message });
  }
}

// ─── Index Routes ────────────────────────────────────────────────────────────

/**
 * POST /api/index
 * Index content for later verification.
 * Body: { source: string }
 */
app.post("/api/index", async (req: Request, res: Response) => {
  const { source } = req.body || {};
  if (!source || typeof source !== "string") {
    return res.status(400).json({ error: "source is required", code: "INVALID_CONFIG" });
  }

  try {
    const result = await getPoCW().index(source);
    const status = result.status === "ready" ? 200 : 202;
    if (status === 202) res.set("Retry-After", "5");
    return res.status(status).json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * GET /api/index/:knowledgeId
 * Check indexing status.
 */
app.get("/api/index/:knowledgeId", (req: Request, res: Response) => {
  try {
    const result = getPoCW().getIndexStatus(req.params.knowledgeId);
    const status = result.status === "ready" ? 200 : 202;
    if (status === 202) res.set("Retry-After", "5");
    return res.status(status).json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── Verify Routes ───────────────────────────────────────────────────────────

/**
 * POST /api/verify
 * Start a verification session.
 * Body: { knowledgeId, subject, config? }
 */
app.post("/api/verify", async (req: Request, res: Response) => {
  const { knowledgeId, subject, config } = req.body || {};
  if (!knowledgeId || !subject) {
    return res.status(400).json({ error: "knowledgeId and subject required", code: "INVALID_CONFIG" });
  }

  try {
    // Always use session mode for HTTP API (no onQuestion callback)
    const safeConfig = { ...(config || {}) };
    delete safeConfig.onQuestion;
    const session = (await getPoCW().verify(knowledgeId, String(subject), safeConfig)) as unknown as VerifySession;
    verifySessions.set(session.sessionId, session);

    return res.json({
      sessionId: session.sessionId,
      question: session.currentQuestion,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * POST /api/verify/:sessionId/answer
 * Submit an answer to the current question.
 * Body: { answer: string }
 */
app.post("/api/verify/:sessionId/answer", async (req: Request, res: Response) => {
  const { answer } = req.body || {};
  if (typeof answer !== "string" || answer.length === 0 || answer.length > MAX_ANSWER_LENGTH) {
    return res.status(400).json({
      error: `answer is required (1-${MAX_ANSWER_LENGTH} characters)`,
      code: "INVALID_CONFIG"
    });
  }

  const session = verifySessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found", code: "CONTENT_NOT_FOUND" });
  }

  try {
    const feedback = await session.submitAnswer(answer);
    return res.json(feedback);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * GET /api/verify/:sessionId/result
 * Get the final result of a completed session.
 */
app.get("/api/verify/:sessionId/result", async (req: Request, res: Response) => {
  const session = verifySessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found", code: "CONTENT_NOT_FOUND" });
  }

  try {
    const result = await session.getResult();
    // Cleanup completed session
    verifySessions.delete(req.params.sessionId);
    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

export default app;
