import express, { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import * as path from "path";
import { PoCW } from "./sdk/index";
import { VerifySession } from "./sdk/verify-session";
import { PoCWError, PoCWErrorCode } from "./sdk/types";
import { initSessionStore, saveSession, loadSession, deleteSession } from "./services/session-store";
import { getFullGraph, isFalkorAvailable } from "./services/kg-store";
import { getContent, updateMetadata, updateAccess, listContent as storeListContent } from "./sdk/content-store";
import { checkHasPaid, checkHoldsPrereqSBT, signPriceQuote } from "./services/access-guard";
import { rederiveTitle } from "./services/parser";
import { initAttestationStore, saveAttestation, getAttestation, listAttestationsBySubject } from "./services/attestation-store";
import { buildAttestation } from "./sdk/attestation";
import { controllerAddress as cfgController, sbtAddress as cfgSbt } from "./services/chain-config";
import { ethers } from "ethers";

/** Deterministic per-holder ERC-1155 token id (matches PoCW_Controller.sbtTokenId). */
function sbtTokenId(user: string, contentId: number): string {
  return ethers.toBigInt(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [user, BigInt(contentId)])
  )).toString();
}

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
app.use(express.static(path.join(__dirname, "..", "public")));

// 3.4 — Rate limiting: 30 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down", code: "CAPACITY_EXCEEDED" },
});
app.use(limiter);

// API key auth — required in production, optional in local dev.
// Set POCW_API_KEY in .env to protect all /api routes.
// If NODE_ENV=production and POCW_API_KEY is unset, the server will refuse to start (see server.ts).
const API_KEY = process.env.POCW_API_KEY;
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
    next(); // open mode — local dev only
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
  initAttestationStore();
}

const MAX_ANSWER_LENGTH = 50_000;
const SUPPORTED_SOURCE_PROTOCOLS = new Set(["http:", "https:", "ipfs:"]);

function validateIndexSourceUrl(source: string): string | null {
  const value = source.trim();
  if (!value) {
    return "source is required";
  }

  if (value.startsWith("ipfs://")) {
    const remainder = value.slice("ipfs://".length).trim();
    if (!remainder || remainder.startsWith("/") || /\s/.test(remainder)) {
      return "Invalid source URL. Use ipfs://<CID>[/path]";
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "Invalid source URL. Use http://, https://, or ipfs://";
  }

  if (!SUPPORTED_SOURCE_PROTOCOLS.has(parsed.protocol)) {
    return `Unsupported source URL protocol \"${parsed.protocol}\". Use http://, https://, or ipfs://`;
  }

  if (!parsed.hostname) {
    return "Invalid source URL. Hostname is required";
  }

  return null;
}

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

  const validationError = validateIndexSourceUrl(source);
  if (validationError) {
    return res.status(400).json({ error: validationError, code: "INVALID_CONFIG" });
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
    const row = getContent(req.params.knowledgeId);
    const status = result.status === "ready" ? 200 : 202;
    if (status === 202) res.set("Retry-After", "5");
    return res.status(status).json({
      ...result,
      title: row?.title ?? undefined,
      source: row?.source ?? undefined,
    });
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

  // ── Access gate ────────────────────────────────────────────────────────────
  const row = getContent(knowledgeId);
  if (row) {
    const tier = row.tier ?? "free";
    const contentId = row.content_id ?? 0;

    if (tier === "paid") {
      // Verify caller has paid via KalPaywall
      const paid = await checkHasPaid(String(subject), contentId);
      if (!paid) {
        return res.status(403).json({
          error: "Payment required — purchase access with KAL first",
          code: "ACCESS_DENIED",
          tier: "paid",
          contentId,
        });
      }
    } else if (tier === "unlocked") {
      // Verify caller holds a prerequisite SBT. Fail CLOSED: an unlocked-tier course whose
      // unlock_rule is missing/malformed/empty must NOT be served openly.
      let prereqIds: number[] = [];
      if (row.unlock_rule) {
        try {
          const rule = JSON.parse(row.unlock_rule) as { sbtContentIds?: number[] };
          if (Array.isArray(rule.sbtContentIds)) prereqIds = rule.sbtContentIds;
        } catch { /* malformed rule — prereqIds stays empty → fail closed below */ }
      }
      if (prereqIds.length === 0) {
        return res.status(403).json({
          error: "This course is gated but its unlock rule is misconfigured — access denied",
          code: "ACCESS_DENIED",
          tier: "unlocked",
          contentId,
        });
      }
      const holds = await checkHoldsPrereqSBT(String(subject), prereqIds);
      if (!holds) {
        return res.status(403).json({
          error: "SBT required — you must hold a qualifying credential to access this course",
          code: "ACCESS_DENIED",
          tier: "unlocked",
          prereqContentIds: prereqIds,
        });
      }
    }
    // tier === "free" → no gate
  }
  // ── End access gate ────────────────────────────────────────────────────────

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
      importantConceptCount: session.importantConceptCount,
      maxQuestions: session.maxQuestions,
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
    const row = getContent(session.knowledgeId);
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
    const row = getContent(session.knowledgeId);
    if (row?.source) {
      const { chunks } = await (pocw as any).getContentChunks(session.knowledgeId, row.source);
      session.rehydrateChunks(chunks);
    }
    verifySessions.set(sessionId, session);
  }

  try {
    const result = await session.getResult();

    // Persist a passing attestation so the learner can re-mint later (recovery) and the account
    // page can list earned SBTs. KAL + SBT are minted on-chain by the user via verifyAndMint —
    // the oracle no longer mints off-chain.
    if (result.competenceIndicator && result.attestation && result.tokenUri) {
      saveAttestation({
        subject: result.subject,
        contentId: result.contentId,
        knowledgeId: result.knowledgeId,
        score: Math.round(result.score),
        kalAmountWei: result.attestation.kalAmount,
        tokenUri: result.tokenUri,
        contentHash: result.attestation.contentHash,
      });
    }

    verifySessions.delete(sessionId);
    await deleteSession(sessionId);
    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * POST /api/verify/reattest — re-issue a fresh attestation (new nonce/expiry) for a passing
 * session the learner already earned, so they can mint later (e.g. after they get gas).
 * Body: { address, contentId }.
 */
app.post("/api/verify/reattest", async (req: Request, res: Response) => {
  const { address, contentId } = req.body ?? {};
  if (!address || typeof address !== "string" || contentId == null) {
    return res.status(400).json({ error: "address and contentId required", code: "INVALID_CONFIG" });
  }
  const stored = getAttestation(address, Number(contentId));
  if (!stored) {
    return res.status(404).json({ error: "No earned attestation for this address + content", code: "CONTENT_NOT_FOUND" });
  }
  try {
    const controllerAddr = cfgController();
    const sbtAddr = cfgSbt();
    const chain = controllerAddr && sbtAddr
      ? { controllerAddress: controllerAddr, sbtAddress: sbtAddr }
      : undefined;
    const attestation = await buildAttestation(
      chain ? "onchain" : "offchain",
      stored.subject,
      stored.contentId,
      stored.score,
      stored.kalAmountWei,
      stored.tokenUri,
      stored.contentHash ?? "",
      chain
    );
    return res.json({ attestation, subject: stored.subject, contentId: stored.contentId, tokenUri: stored.tokenUri });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * GET /api/sbts/:address — list the SBTs a learner has earned (from oracle records), so the
 * account page can show them + verify with on-chain balanceOf, without scanning the chain.
 */
app.get("/api/sbts/:address", (req: Request, res: Response) => {
  const address = req.params.address;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: "Invalid address", code: "INVALID_CONFIG" });
  }
  const items = listAttestationsBySubject(address).map((a) => ({
    contentId: a.contentId,
    tokenId: sbtTokenId(address, a.contentId),
    knowledgeId: a.knowledgeId,
    score: a.score,
    tokenUri: a.tokenUri,
  }));
  return res.json({ address, sbts: items });
});

/**
 * PATCH /api/index/:knowledgeId/title
 * Re-derive and store a title for any indexed content (or accept a custom one).
 *
 * Without a body: re-fetches the source URL and derives the title via:
 *   YouTube → oEmbed  |  Web page → LLM(htmlTitle + URL + 4k chars)
 * With body { title: string }: stores the provided title directly.
 *
 * This fixes entries that were indexed before the strict YouTube detection
 * was deployed (e.g. Wikipedia URLs that got "YouTube video <slug>" titles).
 */
app.patch("/api/index/:knowledgeId/title", async (req: Request, res: Response) => {
  const row = getContent(req.params.knowledgeId);
  if (!row) {
    return res.status(404).json({ error: "Content not found", code: "CONTENT_NOT_FOUND" });
  }

  // Accept an explicit title override
  let title: string | undefined = req.body?.title ?? undefined;

  // Auto-derive when no title is given
  if (!title) {
    try {
      const derived = await rederiveTitle(row.source);
      title = derived ?? undefined;
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

// ─── Graph Visualization ─────────────────────────────────────────────────────

/**
 * GET /api/graph/:knowledgeId
 * Returns the knowledge graph (nodes + edges) for a content ID.
 * Used by the graph visualization viewer.
 */
app.get("/api/graph/:knowledgeId", async (req: Request, res: Response) => {
  if (!isFalkorAvailable()) {
    return res.status(503).json({ error: "FalkorDB unavailable", code: "INVALID_CONFIG" });
  }

  // Accept either the string knowledgeId (primary key) or a legacy numeric contentId.
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
    const graph = await getFullGraph(contentId);
    return res.json(graph);
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────
//
// Cosmetic admin address check: compares the X-Admin-Address header against the
// ADMIN_ADDRESS env var (case-insensitive). The real protection is the API key
// middleware already applied to all /api/* routes. For thesis-demo purposes this
// is sufficient; full protection would require admin wallet signature verification.

const ADMIN_ADDRESS = (process.env.ADMIN_ADDRESS ?? "").toLowerCase();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_ADDRESS) {
    next(); // No address configured — open (dev mode only)
    return;
  }
  const addr = (req.headers["x-admin-address"] as string ?? "").toLowerCase();
  if (addr !== ADMIN_ADDRESS) {
    res.status(403).json({ error: "Forbidden — admin wallet required", code: "INVALID_CONFIG" });
    return;
  }
  next();
}

/**
 * GET /api/admin/access
 * List all content with their access-control fields.
 */
app.get("/api/admin/access", requireAdmin, (_req: Request, res: Response) => {
  try {
    const { rows } = storeListContent({ limit: 200 });
    const items = rows.map((r) => ({
      knowledgeId: r.knowledge_id,
      contentId: r.content_id,
      title: r.title,
      source: r.source,
      status: r.status,
      tier: r.tier ?? "free",
      kalPrice: r.kal_price ?? null,
      unlockRule: r.unlock_rule ? JSON.parse(r.unlock_rule) : null,
    }));
    return res.json({ items });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PATCH /api/admin/access/:knowledgeId
 * Set the access tier (free / paid / unlocked) and associated rule.
 * Body: { tier, kalPrice?, unlockRule? }
 */
app.patch("/api/admin/access/:knowledgeId", requireAdmin, async (req: Request, res: Response) => {
  const { knowledgeId } = req.params;
  const row = getContent(knowledgeId);
  if (!row) {
    return res.status(404).json({ error: "Content not found", code: "CONTENT_NOT_FOUND" });
  }

  const { tier, kalPrice, unlockRule } = req.body ?? {};
  const validTiers = ["free", "paid", "unlocked"];
  if (!tier || !validTiers.includes(tier)) {
    return res.status(400).json({ error: `tier must be one of: ${validTiers.join(", ")}`, code: "INVALID_CONFIG" });
  }
  if (tier === "paid" && (kalPrice == null || typeof kalPrice !== "number" || kalPrice <= 0)) {
    return res.status(400).json({ error: "paid tier requires a positive numeric kalPrice", code: "INVALID_CONFIG" });
  }
  if (tier === "unlocked") {
    if (!unlockRule || unlockRule.mode !== "any" || !Array.isArray(unlockRule.sbtContentIds) || unlockRule.sbtContentIds.length === 0) {
      return res.status(400).json({ error: "unlocked tier requires unlockRule: { mode: 'any', sbtContentIds: number[] }", code: "INVALID_CONFIG" });
    }
  }

  try {
    await updateAccess(knowledgeId, {
      tier,
      kalPrice: tier === "paid" ? kalPrice : null,
      unlockRule: tier === "unlocked" ? unlockRule : null,
    });
    return res.json({ knowledgeId, tier, kalPrice: kalPrice ?? null, unlockRule: unlockRule ?? null });
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── Access Quote ─────────────────────────────────────────────────────────────

/**
 * POST /api/access/quote
 * Issue an oracle-signed price quote for a paid-tier course.
 * The frontend presents this to KalPaywall.purchase().
 * Body: { knowledgeId, buyer }
 */
app.post("/api/access/quote", async (req: Request, res: Response) => {
  const { knowledgeId, buyer } = req.body ?? {};
  if (!knowledgeId || !buyer || typeof buyer !== "string") {
    return res.status(400).json({ error: "knowledgeId and buyer (address) required", code: "INVALID_CONFIG" });
  }

  const row = getContent(knowledgeId);
  if (!row) {
    return res.status(404).json({ error: "Content not found", code: "CONTENT_NOT_FOUND" });
  }
  if ((row.tier ?? "free") !== "paid") {
    return res.status(400).json({ error: "Course is not a paid tier — no quote needed", code: "INVALID_CONFIG" });
  }
  const kalPrice = row.kal_price;
  if (!kalPrice || kalPrice <= 0) {
    return res.status(400).json({ error: "No price configured for this course", code: "INVALID_CONFIG" });
  }
  const contentId = row.content_id ?? 0;

  try {
    const quote = await signPriceQuote(buyer, contentId, kalPrice);
    if (!quote) {
      // Oracle not configured — return an unsigned placeholder for dev
      return res.json({
        contentId,
        priceKal: kalPrice,
        priceWei: ethers.parseEther(String(kalPrice)).toString(), // decimal-safe (kalPrice may be fractional)
        expiry: Math.floor(Date.now() / 1000) + 600,
        nonce: "0x0000000000000000000000000000000000000000000000000000000000000001",
        signature: "0x",
        unsigned: true,
      });
    }
    return res.json(quote);
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

export default app;
