import express, { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { createHash, timingSafeEqual } from "crypto";
import * as path from "path";
import { PoCW } from "./sdk/index";
import { VerifySession } from "./sdk/verify-session";
import { PoCWError, PoCWErrorCode, ContentRow } from "./sdk/types";
import { initSessionStore, saveSession, loadSession } from "./services/session-store";
import { getFullGraph, isFalkorAvailable } from "./services/kg-store";
import { getContent, updateMetadata } from "./sdk/content-store";
import { rederiveTitle, parseUpload, UploadParseError } from "./services/parser";

const app = express();
app.disable("x-powered-by");

// ─── Proxy trust ─────────────────────────────────────────────────────────────
//
// The engine runs behind a server-side proxy (the landing app). To rate-limit per real
// client IP, set TRUST_PROXY to the number of proxy hops that append to X-Forwarded-For
// (e.g. "1"), or any value Express accepts ("loopback", "10.0.0.0/8", "true"...).
// Unset / "false" / "0" → X-Forwarded-For is ignored (default).

export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = (raw ?? "").trim();
  if (!value || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

// ─── CORS (opt-in) ───────────────────────────────────────────────────────────
// Browsers never call the engine directly in the standard deployment (the landing
// proxies server-side), so CORS headers are only sent when CORS_ORIGIN is set.
const CORS_ORIGIN = process.env.CORS_ORIGIN?.trim();
const ALLOW_MODEL_OVERRIDE = process.env.ALLOW_MODEL_OVERRIDE === "true";
if (CORS_ORIGIN) {
  app.use((req: Request, res: Response, next: NextFunction): void => {
    res.header("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// ─── Rate limiting ───────────────────────────────────────────────────────────

const rateLimitMessage = { error: "Too many requests — please slow down", code: "CAPACITY_EXCEEDED" };

/** Index status polling (GET /api/index/:knowledgeId) — frequent but cheap. */
function isStatusPoll(req: Request): boolean {
  return req.method === "GET" && /^\/api\/index\/[^/]+\/?$/.test(req.path);
}

// Main limiter: 30 requests per minute per client IP (status polling + /health excluded).
const limiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage,
  skip: (req) => req.path === "/health" || isStatusPoll(req),
});

// Status polling gets its own generous budget (a client polling every ~5 s uses 12/min).
const statusLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage,
});

app.use(limiter);
app.use((req: Request, res: Response, next: NextFunction) =>
  isStatusPoll(req) ? statusLimiter(req, res, next) : next()
);

// ─── Auth ────────────────────────────────────────────────────────────────────

/** Constant-time bearer check (hashing first removes the length side-channel). */
function bearerMatches(req: Request, secret: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const given = createHash("sha256").update(match[1].trim()).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected);
}

function isAdminPath(req: Request): boolean {
  return req.path === "/admin" || req.path.startsWith("/admin/");
}

// API key auth for /api/* (admin routes use ADMIN_API_KEY instead — see below).
// When POCW_API_KEY is unset the API is open (local dev only; server.ts refuses to start
// without it when NODE_ENV=production).
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (isAdminPath(req)) return next();
  const apiKey = process.env.POCW_API_KEY;
  if (!apiKey) return next();
  if (!bearerMatches(req, apiKey)) {
    res.status(401).json({ error: "Unauthorized — invalid or missing API key", code: "UNAUTHORIZED" });
    return;
  }
  next();
}
app.use("/api", requireApiKey);

// Admin auth: separate bearer ADMIN_API_KEY. Unset → admin API disabled (403).
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    res.status(403).json({ error: "Admin API disabled — ADMIN_API_KEY is not configured", code: "FORBIDDEN" });
    return;
  }
  if (!bearerMatches(req, adminKey)) {
    res.status(401).json({ error: "Unauthorized — invalid or missing admin key", code: "UNAUTHORIZED" });
    return;
  }
  next();
}
app.use("/api/admin", requireAdmin);

// ─── Shared state ────────────────────────────────────────────────────────────

let pocw: PoCW | null = null;

export function setPoCWInstance(instance: PoCW): void {
  pocw = instance;
}

function getPoCW(): PoCW {
  if (!pocw) throw new PoCWError("INVALID_CONFIG", "PoCW not initialized");
  return pocw;
}

// Active verify sessions are persisted in Redis (TTL 30 min). This Map is only a bounded
// local cache of hot sessions; the source of truth is Redis.
const SESSION_CACHE_IDLE_MS = 30 * 60_000;
const SESSION_CACHE_MAX = 1000;
const verifySessions = new Map<string, { session: VerifySession; lastUsed: number }>();
/** Session ids with an answer currently being graded (see POST /api/verify/:id/answer). */
const answersInFlight = new Set<string>();

function cacheSession(session: VerifySession): void {
  verifySessions.delete(session.sessionId);
  verifySessions.set(session.sessionId, { session, lastUsed: Date.now() });
  while (verifySessions.size > SESSION_CACHE_MAX) {
    const oldest = verifySessions.keys().next().value;
    if (oldest === undefined) break;
    verifySessions.delete(oldest);
  }
}

const sweeper = setInterval(() => {
  const cutoff = Date.now() - SESSION_CACHE_IDLE_MS;
  for (const [id, entry] of verifySessions) {
    if (entry.lastUsed < cutoff) verifySessions.delete(id);
  }
}, 5 * 60_000);
sweeper.unref();

/** Local cache → Redis. Rehydrates content chunks for sessions that still need them. */
async function getSession(sessionId: string): Promise<VerifySession | undefined> {
  const cached = verifySessions.get(sessionId);
  if (cached) {
    cacheSession(cached.session);
    return cached.session;
  }
  const session = await loadSession(sessionId);
  if (!session) return undefined;
  if (!session.isComplete()) {
    const { chunks } = await getPoCW().getContentChunks(session.knowledgeId);
    session.rehydrateChunks(chunks);
  }
  cacheSession(session);
  return session;
}

export async function initAppServices(): Promise<void> {
  await initSessionStore();
}

const MAX_ANSWER_LENGTH = 50_000;
const MAX_SUBJECT_LENGTH = 200;
/** Whole books: PDF / EPUB / TXT / MD up to 40 MB. */
const UPLOAD_LIMIT = "40mb";

function validateIndexSourceUrl(source: string): string | null {
  const value = source.trim();
  if (!value) return "source is required";

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "Invalid source URL. Use http:// or https://";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Unsupported source URL protocol "${parsed.protocol}". Use http:// or https://`;
  }
  if (!parsed.hostname) return "Invalid source URL. Hostname is required";
  return null;
}

// ─── Error mapping ───────────────────────────────────────────────────────────

const HTTP_STATUS: Record<PoCWErrorCode, number> = {
  CONTENT_NOT_FOUND: 404,
  INDEXING_IN_PROGRESS: 202,
  INDEXING_FAILED: 422,
  INVALID_CONFIG: 400,
  SESSION_EXPIRED: 410,
  SESSION_NOT_ACTIVE: 409,
  LLM_ERROR: 503,
  GRAPH_DB_ERROR: 503,
  CAPACITY_EXCEEDED: 429,
};

function sendError(res: Response, err: unknown): void {
  if (err instanceof PoCWError) {
    const status = HTTP_STATUS[err.code] || 500;
    if (err.code === "INDEXING_IN_PROGRESS") res.set("Retry-After", "5");
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "QuestionGenerationError" || name === "GradingError") {
    console.error(`[engine] ${name}:`, (err as Error).message);
    res.status(503).json({ error: "LLM temporarily unavailable — please retry", code: "LLM_ERROR" });
    return;
  }
  console.error("[engine] Unhandled error:", err instanceof Error ? err.message : err);
  res.status(500).json({ error: "Internal server error", code: "INTERNAL" });
}

/** 200 when ready/failed (terminal), 202 + Retry-After while pending/indexing. */
function sendIndexResult(res: Response, body: { status: string } & Record<string, unknown>): void {
  const terminal = body.status === "ready" || body.status === "failed";
  if (!terminal) res.set("Retry-After", "5");
  res.status(terminal ? 200 : 202).json(body);
}

/** Public view of a content row. Raw-text sources (uploads) are truncated — they can be MBs. */
function publicRow(row: ContentRow): ContentRow {
  if (row.content_type === "raw_text" && row.source.length > 300) {
    return { ...row, source: `${row.source.slice(0, 300)}…` };
  }
  return row;
}

// ─── Upload ──────────────────────────────────────────────────────────────────

/**
 * POST /api/upload
 * Raw body upload (<= 40 MB). Text is extracted server-side and indexed.
 *   application/epub+zip      → EPUB (title/author from the package metadata)
 *   application/pdf           → pdf-parse (title/author from the document info when meaningful)
 *   text/*                    → UTF-8 (text/markdown kept verbatim, other text re-flowed)
 *   application/octet-stream  → EPUB / PDF when the bytes say so, else UTF-8 text
 * Project Gutenberg license text is stripped; text beyond 4 M characters is cut.
 */
app.post(
  "/api/upload",
  express.raw({
    type: ["application/pdf", "application/epub+zip", "text/*", "application/octet-stream"],
    limit: UPLOAD_LIMIT,
  }),
  async (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body)) {
      return res.status(415).json({
        error: "Unsupported Content-Type — use application/pdf, application/epub+zip, text/* or application/octet-stream",
        code: "INVALID_CONFIG",
      });
    }
    if (req.body.length === 0) {
      return res.status(400).json({ error: "No file body received", code: "INVALID_CONFIG" });
    }
    try {
      let doc;
      try {
        doc = await parseUpload(req.body as Buffer, String(req.headers["content-type"] ?? ""));
      } catch (err) {
        if (err instanceof UploadParseError) {
          return res.status(err.status).json({ error: err.message, code: "INVALID_CONFIG" });
        }
        throw err;
      }
      req.body = undefined; // let the raw upload be collected while indexing runs
      const result = await getPoCW().index(doc.text, {
        asText: true,
        meta: { title: doc.title, author: doc.author },
      });
      return sendIndexResult(res, { ...result });
    } catch (err) {
      return sendError(res, err);
    }
  }
);

// ─── Index ───────────────────────────────────────────────────────────────────

/**
 * POST /api/index
 * Body: { source: "https://..." }
 */
app.post("/api/index", async (req: Request, res: Response) => {
  const { source } = req.body || {};
  if (!source || typeof source !== "string") {
    return res.status(400).json({ error: "source is required", code: "INVALID_CONFIG" });
  }
  const validationError = validateIndexSourceUrl(source);
  if (validationError) {
    return res.status(400).json({ error: validationError, code: "INVALID_CONFIG" });
  }
  try {
    const result = await getPoCW().index(source.trim());
    return sendIndexResult(res, { ...result });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * GET /api/index
 * List indexed content (paginated). Query: status?, limit? (default 50, max 200), offset?
 */
app.get("/api/index", (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
    const result = getPoCW().listContent({
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      limit: limit && limit > 0 ? Math.min(limit, 200) : undefined,
      offset: offset && offset > 0 ? offset : undefined,
    });
    return res.json({ rows: result.rows.map(publicRow), total: result.total });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * GET /api/index/:knowledgeId
 * Indexing status. 202 + Retry-After while pending/indexing; 200 once ready or failed.
 */
app.get("/api/index/:knowledgeId", (req: Request, res: Response) => {
  try {
    const result = getPoCW().getIndexStatus(req.params.knowledgeId);
    const row = getContent(req.params.knowledgeId);
    return sendIndexResult(res, {
      ...result,
      title: row?.title ?? undefined,
      author: row?.author ?? undefined,
      // Only URL sources are echoed back (uploaded text can be several MB).
      source: row && row.content_type === "url" ? row.source : undefined,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * GET /api/index/:knowledgeId/text
 * The full extracted text of a resource (what the graph and questions are built from), as
 * text/plain. For URL sources it is re-fetched if it isn't cached.
 */
app.get("/api/index/:knowledgeId/text", async (req: Request, res: Response) => {
  if (!getContent(req.params.knowledgeId)) {
    return res.status(404).json({ error: "Content not found", code: "CONTENT_NOT_FOUND" });
  }
  try {
    const { text } = await getPoCW().getContentChunks(req.params.knowledgeId);
    res.set("Cache-Control", "no-store");
    return res.type("text/plain; charset=utf-8").send(text);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PATCH /api/index/:knowledgeId/title
 * Re-derive the title from the source (no body) or store a custom one ({ title }).
 */
app.patch("/api/index/:knowledgeId/title", async (req: Request, res: Response) => {
  const row = getContent(req.params.knowledgeId);
  if (!row) {
    return res.status(404).json({ error: "Content not found", code: "CONTENT_NOT_FOUND" });
  }

  const provided = req.body?.title;
  let title: string | undefined = typeof provided === "string" && provided.trim()
    ? provided.trim().slice(0, 300)
    : undefined;

  if (!title && row.content_type === "url") {
    try {
      title = (await rederiveTitle(row.source)) ?? undefined;
    } catch {
      // derivation failed — fall through to error below
    }
  }

  if (!title) {
    return res.status(400).json({
      error: "Could not derive title — provide one in body: { title }",
      code: "INVALID_CONFIG",
    });
  }

  await updateMetadata(row.knowledge_id, title, row.description ?? "");
  return res.json({ knowledgeId: row.knowledge_id, title });
});

// ─── Verify ──────────────────────────────────────────────────────────────────

/**
 * POST /api/verify
 * Body: { knowledgeId, subject?, config? } — subject is an optional free-form learner label.
 */
app.post("/api/verify", async (req: Request, res: Response) => {
  const { knowledgeId, subject, config } = req.body || {};
  if (!knowledgeId || typeof knowledgeId !== "string") {
    return res.status(400).json({ error: "knowledgeId is required", code: "INVALID_CONFIG" });
  }
  if (subject !== undefined && subject !== null && typeof subject !== "string") {
    return res.status(400).json({ error: "subject must be a string", code: "INVALID_CONFIG" });
  }
  if (config !== undefined && config !== null && (typeof config !== "object" || Array.isArray(config))) {
    return res.status(400).json({ error: "config must be an object", code: "INVALID_CONFIG" });
  }
  const label = (typeof subject === "string" && subject.trim() ? subject.trim() : "anonymous")
    .slice(0, MAX_SUBJECT_LENGTH);

  try {
    // Always session mode over HTTP (no onQuestion callback).
    const safeConfig = { ...(config || {}) };
    delete safeConfig.onQuestion;
    // The LLM model decides cost; HTTP callers may only pick it when explicitly allowed.
    if (!ALLOW_MODEL_OVERRIDE) delete safeConfig.model;
    const session = (await getPoCW().verify(knowledgeId, label, safeConfig)) as unknown as VerifySession;
    cacheSession(session);
    await saveSession(session);

    return res.json({
      sessionId: session.sessionId,
      question: session.currentQuestion,
      importantConceptCount: session.importantConceptCount,
      maxQuestions: session.maxQuestions,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * POST /api/verify/:sessionId/answer
 * Body: { answer: string }
 */
app.post("/api/verify/:sessionId/answer", async (req: Request, res: Response) => {
  const { answer } = req.body || {};
  if (typeof answer !== "string" || answer.length === 0 || answer.length > MAX_ANSWER_LENGTH) {
    return res.status(400).json({
      error: `answer is required (1-${MAX_ANSWER_LENGTH} characters)`,
      code: "INVALID_CONFIG",
    });
  }

  // One answer per session at a time: a double-submit would otherwise grade twice and
  // advance the session past a question the learner never saw.
  const sessionId = req.params.sessionId;
  if (answersInFlight.has(sessionId)) {
    return res.status(409).json({
      error: "An answer for this session is already being processed",
      code: "SESSION_BUSY",
    });
  }
  answersInFlight.add(sessionId);
  try {
    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found", code: "SESSION_EXPIRED" });
    }
    const feedback = await session.submitAnswer(answer);
    await saveSession(session);
    const payload: Record<string, unknown> = { ...feedback };
    if (!feedback.isComplete && session.isActive()) {
      payload.nextQuestion = session.currentQuestion;
    }
    return res.json(payload);
  } catch (err) {
    // submitAnswer mutates the session before it can fail (e.g. next-question generation);
    // drop the local copy so a retry starts again from the last state saved in Redis.
    verifySessions.delete(sessionId);
    return sendError(res, err);
  } finally {
    answersInFlight.delete(sessionId);
  }
});

/**
 * GET /api/verify/:sessionId/result
 * Final result of a completed session. Idempotent while the session lives in Redis (30 min).
 */
app.get("/api/verify/:sessionId/result", async (req: Request, res: Response) => {
  try {
    const session = await getSession(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found", code: "SESSION_EXPIRED" });
    }
    const result = await session.getResult();
    await saveSession(session); // persist the frozen result
    verifySessions.delete(session.sessionId); // completed — no need to keep it hot
    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── Graph ───────────────────────────────────────────────────────────────────

/**
 * GET /api/graph/:knowledgeId
 * Knowledge graph { contentId, nodes, edges }. Also accepts a numeric contentId.
 */
app.get("/api/graph/:knowledgeId", async (req: Request, res: Response) => {
  if (!isFalkorAvailable()) {
    return res.status(503).json({ error: "Graph database unavailable", code: "GRAPH_DB_ERROR" });
  }

  let contentId: number;
  const param = req.params.knowledgeId;
  const numeric = parseInt(param, 10);
  if (!isNaN(numeric) && String(numeric) === param) {
    contentId = numeric;
  } else {
    const row = getContent(param);
    if (!row || row.content_id == null) {
      return res.status(404).json({ error: "Content not found", code: "CONTENT_NOT_FOUND" });
    }
    contentId = row.content_id;
  }

  try {
    return res.json(await getFullGraph(contentId));
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── Admin (Authorization: Bearer <ADMIN_API_KEY>) ───────────────────────────

/**
 * GET /api/admin/content
 * List all content including hidden entries. Query: status?, limit?, offset?
 */
app.get("/api/admin/content", (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
    const result = getPoCW().listContent({
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      limit: limit && limit > 0 ? Math.min(limit, 500) : 200,
      offset: offset && offset > 0 ? offset : undefined,
      includeHidden: true,
    });
    return res.json({ rows: result.rows.map(publicRow), total: result.total });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PATCH /api/admin/content/:knowledgeId/visibility
 * Body: { hidden: boolean } — hide/show in the public catalog (reversible).
 */
app.patch("/api/admin/content/:knowledgeId/visibility", async (req: Request, res: Response) => {
  const { knowledgeId } = req.params;
  const { hidden } = req.body ?? {};
  if (typeof hidden !== "boolean") {
    return res.status(400).json({ error: "hidden (boolean) is required", code: "INVALID_CONFIG" });
  }
  try {
    await getPoCW().setVisibility(knowledgeId, hidden);
    return res.json({ knowledgeId, hidden });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * DELETE /api/admin/content/:knowledgeId
 * Cascade-delete a resource (graph + content row + cache).
 */
app.delete("/api/admin/content/:knowledgeId", async (req: Request, res: Response) => {
  try {
    const result = await getPoCW().deleteResource(req.params.knowledgeId);
    return res.json({ deleted: true, ...result });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * POST /api/admin/content/:knowledgeId/reindex
 * Drop the graph and re-index from the original source. 202 + Retry-After; poll GET /api/index/:id.
 */
app.post("/api/admin/content/:knowledgeId/reindex", async (req: Request, res: Response) => {
  try {
    const result = await getPoCW().reindexResource(req.params.knowledgeId);
    res.set("Retry-After", "5");
    return res.status(202).json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * POST /api/admin/wipe
 * Wipe ALL resources (every graph + content row + cache).
 */
app.post("/api/admin/wipe", async (_req: Request, res: Response) => {
  try {
    const result = await getPoCW().wipeAll();
    return res.json({ wiped: true, ...result });
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", falkordb: isFalkorAvailable() });
});

// ─── Fallbacks ───────────────────────────────────────────────────────────────

app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
});

// Body-parser errors (malformed JSON, payload too large) → JSON instead of an HTML page.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const e = err as { status?: number; type?: string; message?: string };
  if (e?.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large", code: "INVALID_CONFIG" });
  }
  if (e?.status && e.status >= 400 && e.status < 500) {
    return res.status(e.status).json({ error: e.message || "Bad request", code: "INVALID_CONFIG" });
  }
  return sendError(res, err);
});

export default app;
