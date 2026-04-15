import express, { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { PoCW } from "./sdk/index";
import { VerifySession } from "./sdk/verify-session";
import { PoCWError, PoCWErrorCode } from "./sdk/types";
import { initSessionStore, saveSession, loadSession, deleteSession } from "./services/session-store";

const app = express();

// CORS — allow the Next.js dev frontend (port 3001) and any CORS_ORIGIN override
app.use((req: Request, res: Response, next: NextFunction): void => {
  const origin = process.env.CORS_ORIGIN ?? "http://localhost:3001";
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());

// 3.4 — Rate limiting: 30 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down", code: "CAPACITY_EXCEEDED" },
});
app.use(limiter);

// 3.4 — Optional API key authentication via POCW_API_KEY env var.
// If the variable is not set, the check is disabled (open mode).
const API_KEY = process.env.POCW_API_KEY;
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
    next();
    return;
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: "Unauthorized — invalid or missing API key", code: "INVALID_CONFIG" });
    return;
  }
  next();
}
app.use("/api", requireApiKey);

// Shared PoCW instance (initialized by server.ts)
let pocw: PoCW | null = null;

export function setPoCWInstance(instance: PoCW): void {
  pocw = instance;
}

function getPoCW(): PoCW {
  if (!pocw) throw new PoCWError("INVALID_CONFIG", "PoCW not initialized");
  return pocw;
}

// Active verify sessions are persisted in Redis (TTL 30 min).
// The Map is only a local cache for hot sessions — the source of truth is Redis.
const verifySessions = new Map<string, VerifySession>();

export async function initAppServices(): Promise<void> {
  await initSessionStore();
}

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

// ─── File Upload Route ───────────────────────────────────────────────────────

/**
 * POST /api/upload
 * Upload a binary file (PDF or text). Extracts text server-side and indexes it.
 * Content-Type: application/pdf  → extracted via pdf-parse
 * Content-Type: text/*           → decoded as UTF-8
 */
app.post(
  "/api/upload",
  requireApiKey,
  express.raw({ type: ["application/pdf", "text/*", "application/octet-stream"], limit: "10mb" }),
  async (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "No file body received", code: "INVALID_CONFIG" });
    }
    try {
      let text: string;
      const ct = req.headers["content-type"] ?? "";
      if (ct.includes("pdf")) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pdfParse = require("pdf-parse") as (b: Buffer) => Promise<{ text: string }>;
        const parsed = await pdfParse(req.body);
        text = parsed.text;
        if (!text.trim()) {
          return res.status(422).json({ error: "No text found in PDF — it may be image-only", code: "INVALID_CONFIG" });
        }
      } else {
        text = req.body.toString("utf-8");
      }
      const result = await getPoCW().index(text);
      const status = result.status === "ready" ? 200 : 202;
      if (status === 202) res.set("Retry-After", "5");
      return res.status(status).json(result);
    } catch (err) {
      return sendError(res, err);
    }
  }
);

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
 * GET /api/index
 * List all indexed content (paginated).
 * Query params: status?, limit? (default 50), offset? (default 0)
 */
app.get("/api/index", (req: Request, res: Response) => {
  try {
    const result = getPoCW().listContent({
      status: req.query.status as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    });
    return res.json(result);
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
    await saveSession(session);

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

  const sessionId = req.params.sessionId;
  let session = verifySessions.get(sessionId);

  // Fall back to Redis if not in local cache (e.g. after restart)
  if (!session) {
    session = await loadSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found", code: "CONTENT_NOT_FOUND" });
    }
    // Rehydrate chunks from contentCache
    const pocw = getPoCW();
    const row = (pocw as any).getContent?.(session.knowledgeId);
    if (row?.source) {
      const { chunks } = await (pocw as any).getContentChunks(session.knowledgeId, row.source);
      session.rehydrateChunks(chunks);
    }
    verifySessions.set(sessionId, session);
  }

  try {
    const feedback = await session.submitAnswer(answer);
    await saveSession(session);
    const payload: Record<string, unknown> = { ...feedback };
    if (!feedback.isComplete && session.isActive()) {
      payload.nextQuestion = session.currentQuestion;
    }
    return res.json(payload);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * GET /api/verify/:sessionId/result
 * Get the final result of a completed session.
 */
app.get("/api/verify/:sessionId/result", async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId;
  let session = verifySessions.get(sessionId);
  if (!session) {
    session = await loadSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found", code: "CONTENT_NOT_FOUND" });
    }
    const pocw = getPoCW();
    const row = (pocw as any).getContent?.(session.knowledgeId);
    if (row?.source) {
      const { chunks } = await (pocw as any).getContentChunks(session.knowledgeId, row.source);
      session.rehydrateChunks(chunks);
    }
    verifySessions.set(sessionId, session);
  }

  try {
    const result = await session.getResult();
    verifySessions.delete(sessionId);
    await deleteSession(sessionId);
    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

export default app;
