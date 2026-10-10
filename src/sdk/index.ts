/**
 * PoCW SDK — Main Entry Point
 *
 * Two primary operations:
 *   knowledge_id = await pocw.index(source)    // async, indexes in background
 *   result = await pocw.verify(id, subject)    // interactive verification session
 */

import { createHash } from "crypto";
import { parseSource, ParsedDocument, chunkText, isYouTubeStrict, extractYouTubeId } from "../services/parser";
import { prepareText, DocumentMeta } from "../services/book-text";
import { buildKnowledgeGraph } from "../services/kg-builder";
import { storeGraph, graphExists, initFalkorDB, closeFalkorDB, deleteGraph, wipeAllGraphs } from "../services/kg-store";
import { contentUrlToId } from "../services/session-manager";
import {
  initContentStore,
  closeContentStore,
  getContent,
  insertContent,
  markIndexing,
  markReady,
  markFailed,
  incrementUsage,
  recoverStuckIndexingJobs,
  updateMetadata,
  listContent,
  deleteContent,
  wipeAllContent,
  setVisibility as setContentVisibility,
} from "./content-store";
import { VerifySession } from "./verify-session";
import {
  PoCWInitConfig,
  PoCWConfig,
  PoCWResult,
  IndexResult,
  ResolvedConfig,
  resolveConfig,
  PoCWError,
  VerifyQuestion,
  ContentRow,
} from "./types";

export { PoCW };
export { VerifySession } from "./verify-session";
export type {
  PoCWConfig,
  PoCWResult,
  PoCWInitConfig,
  IndexResult,
  VerifyQuestion,
  AnswerFeedback,
  ScoreBreakdown,
  ConceptOutcome,
  CognitiveProfile,
  QuestionType,
  PoCWError,
  PoCWErrorCode,
} from "./types";


// 3.7 — LRU cache replaces unbounded Map to prevent OOM under heavy indexing load.
// Bounded by entry count AND total weight: with whole books (up to 4 M characters each) an
// entry-count bound alone could hold gigabytes.
export class LRUCache<K, V> {
  private map = new Map<K, { value: V; weight: number }>();
  private totalWeight = 0;
  constructor(
    private readonly maxSize: number,
    private readonly maxWeight = Infinity,
    private readonly weigh: (v: V) => number = () => 1,
  ) {}

  get(k: K): V | undefined {
    const e = this.map.get(k);
    if (e !== undefined) {
      // Move to end (most-recently-used position)
      this.map.delete(k);
      this.map.set(k, e);
    }
    return e?.value;
  }

  set(k: K, v: V): void {
    this.delete(k);
    const weight = this.weigh(v);
    this.map.set(k, { value: v, weight });
    this.totalWeight += weight;
    // Evict least-recently-used entries (never the one just added).
    while ((this.map.size > this.maxSize || this.totalWeight > this.maxWeight) && this.map.size > 1) {
      const firstKey = this.map.keys().next().value as K;
      this.delete(firstKey);
    }
  }

  delete(k: K): void {
    const e = this.map.get(k);
    if (e) {
      this.totalWeight -= e.weight;
      this.map.delete(k);
    }
  }

  clear(): void {
    this.map.clear();
    this.totalWeight = 0;
  }

  get size(): number { return this.map.size; }
  get weight(): number { return this.totalWeight; }
}

/**
 * Characters of cached document text (≈ 1–2 bytes each in V8; chunks are slices of the same
 * string). 24 M characters ≈ 6 long novels ≈ 25–50 MB — sized for the 768 MB engine container.
 */
const CONTENT_CACHE_MAX_CHARS = 24_000_000;

/** Cached content text + chunks for indexed content (avoids re-parsing). LRU: 100 entries / 24 M chars. */
const contentCache = new LRUCache<string, { text: string; chunks: string[] }>(
  100, CONTENT_CACHE_MAX_CHARS, v => v.text.length,
);

/** Active background indexing promises */
const indexingJobs = new Map<string, Promise<void>>();

class PoCW {
  private dbPath?: string;
  private initialized = false;

  constructor(config?: PoCWInitConfig) {
    this.dbPath = config?.dbPath;
  }

  /** Initialize FalkorDB and SQLite connections. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await initFalkorDB();
    initContentStore(this.dbPath);
    // 3.1 — Recover jobs stuck in 'indexing' state from a previous crash/restart
    const recovered = await recoverStuckIndexingJobs(15);
    if (recovered > 0) {
      console.warn(`[PoCW] Recovered ${recovered} stuck indexing job(s) from previous session`);
    }
    this.initialized = true;
  }

  private ensureInit(): void {
    if (!this.initialized) {
      throw new PoCWError("INVALID_CONFIG", "PoCW not initialized — call await pocw.init() first");
    }
  }

  /**
   * Index content for later verification.
   * `source` is an http(s) URL, or raw text. Pass `{ asText: true }` to force raw-text
   * handling (e.g. for uploaded files) so the body is never interpreted as a URL.
   * Returns immediately — indexing happens in the background.
   * Idempotent: calling with the same source returns the existing entry.
   */
  async index(source: string, options?: { asText?: boolean; meta?: DocumentMeta }): Promise<IndexResult> {
    this.ensureInit();

    const knowledgeId = computeKnowledgeId(source);
    const numericId = contentUrlToId(normalizeSource(source));

    // Check if already indexed
    const existing = getContent(knowledgeId);
    if (existing) {
      // Failed entries should be retried to avoid permanently caching transient parser/runtime errors.
      if (existing.status === "failed") {
        const retrySource = existing.source || source;
        const retryContentId = existing.content_id ?? numericId;

        await markIndexing(knowledgeId);

        const job = this.runIndexing(knowledgeId, retrySource, retryContentId, existing.content_type, options?.meta);
        indexingJobs.set(knowledgeId, job);
        job.finally(() => indexingJobs.delete(knowledgeId));

        return { knowledgeId, status: "indexing", contentId: retryContentId };
      }

      return {
        knowledgeId,
        status: existing.status as IndexResult["status"],
        contentId: existing.content_id ?? undefined,
        error: existing.error ?? undefined,
      };
    }

    // Determine content type
    const contentType = options?.asText ? "raw_text" : detectContentType(source);

    // Insert as pending
    await insertContent(knowledgeId, contentType, source, numericId);
    await markIndexing(knowledgeId);

    // Start background indexing
    const job = this.runIndexing(knowledgeId, source, numericId, contentType, options?.meta);
    indexingJobs.set(knowledgeId, job);
    job.finally(() => indexingJobs.delete(knowledgeId));

    return { knowledgeId, status: "indexing", contentId: numericId };
  }

  /** Check indexing status for a knowledge ID. */
  getIndexStatus(knowledgeId: string): IndexResult {
    this.ensureInit();
    const row = getContent(knowledgeId);
    if (!row) {
      throw new PoCWError("CONTENT_NOT_FOUND", `No content found for knowledge ID: ${knowledgeId}`);
    }
    return {
      knowledgeId,
      status: row.status as IndexResult["status"],
      contentId: row.content_id ?? undefined,
      error: row.error ?? undefined,
      author: row.author ?? undefined,
    };
  }

  /**
   * List all indexed content. Returns paginated results.
   * Options: { status?, limit?, offset? }
   */
  listContent(options?: {
    status?: string;
    limit?: number;
    offset?: number;
    includeHidden?: boolean;
  }): { rows: ContentRow[]; total: number } {
    this.ensureInit();
    return listContent(options);
  }

  /**
   * Wait for indexing to complete. Polls every 500ms.
   * Throws if indexing fails or times out.
   */
  async waitForIndex(knowledgeId: string, timeoutMs = 300000): Promise<IndexResult> {
    this.ensureInit();

    // If there's an active job, await it directly
    const job = indexingJobs.get(knowledgeId);
    if (job) {
      await job;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = this.getIndexStatus(knowledgeId);
      if (status.status === "ready") return status;
      if (status.status === "failed") {
        throw new PoCWError("INDEXING_FAILED", status.error || "Indexing failed", undefined);
      }
      await sleep(500);
    }

    throw new PoCWError("INDEXING_FAILED", `Indexing timed out after ${timeoutMs}ms`);
  }

  /**
   * Start a verification session.
   *
   * Overload 1: With onQuestion callback — runs the loop and returns PoCWResult.
   * Overload 2: Without callback — returns VerifySession for the caller to drive.
   */
  async verify(
    knowledgeId: string,
    subject: string,
    config: PoCWConfig & { onQuestion: (q: VerifyQuestion) => Promise<string> }
  ): Promise<PoCWResult>;
  async verify(
    knowledgeId: string,
    subject: string,
    config?: PoCWConfig
  ): Promise<VerifySession>;
  async verify(
    knowledgeId: string,
    subject: string,
    config?: PoCWConfig
  ): Promise<PoCWResult | VerifySession> {
    this.ensureInit();
    validateConfig(config);

    // Look up content
    const row = getContent(knowledgeId);
    if (!row) {
      throw new PoCWError("CONTENT_NOT_FOUND", `No content for knowledge ID: ${knowledgeId}`);
    }
    if (row.status === "indexing" || row.status === "pending") {
      throw new PoCWError("INDEXING_IN_PROGRESS", "Content is still being indexed");
    }
    if (row.status === "failed") {
      throw new PoCWError("INDEXING_FAILED", row.error || "Indexing previously failed");
    }

    // Get cached chunks or re-parse
    const { chunks } = await this.getContentChunks(knowledgeId);
    const contentId = row.content_id!;

    // Track usage
    incrementUsage(knowledgeId);

    // Create session
    const resolved = resolveConfig(config);
    const session = new VerifySession(contentId, knowledgeId, chunks, subject, resolved);
    await session.init();

    // If callback mode: drive the loop internally
    if (config?.onQuestion) {
      const onQuestion = config.onQuestion;
      while (session.isActive()) {
        const question = session.currentQuestion;
        const answer = await onQuestion(question);
        await session.submitAnswer(answer);
      }
      return session.getResult();
    }

    return session;
  }

  // ─── Admin operations ──────────────────────────────────────────────────────

  /**
   * Show or hide a resource from the public catalog. Reversible; does not touch the graph.
   */
  async setVisibility(knowledgeId: string, hidden: boolean): Promise<void> {
    this.ensureInit();
    if (!getContent(knowledgeId)) {
      throw new PoCWError("CONTENT_NOT_FOUND", `No content for knowledge ID: ${knowledgeId}`);
    }
    await setContentVisibility(knowledgeId, hidden);
  }

  /**
   * Cascade-delete a resource: removes its FalkorDB graph, its content-store row, and the
   * cached chunks.
   */
  async deleteResource(
    knowledgeId: string
  ): Promise<{ knowledgeId: string; contentId: number | null; nodesDeleted: number }> {
    this.ensureInit();
    const row = getContent(knowledgeId);
    if (!row) {
      throw new PoCWError("CONTENT_NOT_FOUND", `No content for knowledge ID: ${knowledgeId}`);
    }
    const contentId = row.content_id;
    const nodesDeleted = contentId != null ? await deleteGraph(contentId) : 0;
    await deleteContent(knowledgeId);
    contentCache.delete(knowledgeId);
    indexingJobs.delete(knowledgeId);
    return { knowledgeId, contentId, nodesDeleted };
  }

  /**
   * Re-index a resource from its original source: drops the existing graph and re-runs the
   * indexing pipeline in the background. Returns immediately with status 'indexing'.
   */
  async reindexResource(knowledgeId: string): Promise<IndexResult> {
    this.ensureInit();
    const row = getContent(knowledgeId);
    if (!row) {
      throw new PoCWError("CONTENT_NOT_FOUND", `No content for knowledge ID: ${knowledgeId}`);
    }
    const contentId = row.content_id ?? contentUrlToId(normalizeSource(row.source));
    // Drop the old graph so runIndexing rebuilds cleanly (storeGraph MERGEs, so stale nodes
    // would otherwise linger). Evict cached chunks to force a fresh re-parse from source.
    await deleteGraph(contentId);
    contentCache.delete(knowledgeId);
    await markIndexing(knowledgeId);

    const job = this.runIndexing(knowledgeId, row.source, contentId, row.content_type);
    indexingJobs.set(knowledgeId, job);
    job.finally(() => indexingJobs.delete(knowledgeId));

    return { knowledgeId, status: "indexing", contentId };
  }

  /**
   * Wipe ALL resources: clears every FalkorDB graph and every content-store row, and empties
   * the content cache. Returns counts removed.
   */
  async wipeAll(): Promise<{ contentRemoved: number; nodesRemoved: number }> {
    this.ensureInit();
    const nodesRemoved = await wipeAllGraphs();
    const contentRemoved = await wipeAllContent();
    contentCache.clear();
    indexingJobs.clear();
    return { contentRemoved, nodesRemoved };
  }

  /** Close all connections. */
  async close(): Promise<void> {
    await closeFalkorDB();
    closeContentStore();
    contentCache.clear();
    this.initialized = false;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async runIndexing(
    knowledgeId: string,
    source: string,
    contentId: number,
    contentType: string,
    meta?: DocumentMeta
  ): Promise<void> {
    try {
      const doc = await loadDocument(source, contentType, meta);
      const text = doc.text;
      const chunks = chunkText(text);
      const contentHash = createHash("sha256").update(text).digest("hex");

      // One merged graph for the whole document: chunks sampled across the text, extracted with
      // bounded concurrency, concepts merged across chunks and capped (see buildKnowledgeGraph).
      if (!(await graphExists(contentId))) {
        const graph = await buildKnowledgeGraph(contentId, chunks);
        await storeGraph(graph);
      }

      // Cache content for verify()
      contentCache.set(knowledgeId, { text, chunks });

      // Title/author/description. Re-indexing an upload (raw text, no metadata passed) keeps the
      // title/author found at upload time — they cannot be re-derived from the stored text.
      const existing = getContent(knowledgeId);
      if (!(contentType === "raw_text" && !meta && existing?.title)) {
        const { title, description } = await extractMetadata(
          source, text, contentType === "raw_text" ? undefined : doc.htmlTitle ?? null, doc.title,
        );
        await updateMetadata(knowledgeId, title, description, doc.author ?? null);
      }

      await markReady(knowledgeId, contentHash, chunks.length);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown indexing error";
      await markFailed(knowledgeId, message);
    }
  }

  /**
   * Text chunks for an indexed resource (cached; re-parsed from the source after a restart).
   * Used by the HTTP layer to rehydrate sessions loaded from Redis.
   */
  async getContentChunks(knowledgeId: string): Promise<{ text: string; chunks: string[] }> {
    const cached = contentCache.get(knowledgeId);
    if (cached) return cached;

    const row = getContent(knowledgeId);
    if (!row) {
      throw new PoCWError("CONTENT_NOT_FOUND", `No content for knowledge ID: ${knowledgeId}`);
    }
    // Re-parse if not cached (e.g., after restart) — same pipeline as indexing, so the chunks match.
    const { text } = await loadDocument(row.source, row.content_type);
    const chunks = chunkText(text);
    contentCache.set(knowledgeId, { text, chunks });
    return { text, chunks };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Text (+ metadata) of a source. Raw text (uploads are parsed in the HTTP layer and stored as
 * text) only goes through prepareText(), which is idempotent, so re-parsing after a restart
 * yields the same text as indexing did.
 */
async function loadDocument(source: string, contentType: string, meta?: DocumentMeta): Promise<ParsedDocument> {
  if (contentType === "raw_text") return prepareText(source, meta ?? {});
  return parseSource(source);
}

function computeKnowledgeId(source: string): string {
  const normalized = normalizeSource(source).trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Normalize URLs to a canonical form so that equivalent URLs
 * produce the same knowledgeId (e.g. youtu.be vs youtube.com,
 * with/without ?si= tracking params).
 */
function normalizeSource(source: string): string {
  try {
    const url = new URL(source);
    // YouTube: canonicalize to youtube.com/watch?v=VIDEO_ID
    if (url.hostname === "youtu.be" || url.hostname === "www.youtu.be") {
      const videoId = url.pathname.slice(1);
      if (/^[0-9A-Za-z_-]{11}$/.test(videoId)) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }
    if (url.hostname === "youtube.com" || url.hostname === "www.youtube.com") {
      const params = url.searchParams;
      const videoId = params.get("v");
      if (videoId && /^[0-9A-Za-z_-]{11}$/.test(videoId)) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }
  } catch {
    // Not a URL — leave as-is
  }
  return source;
}

/** Only http(s) URLs are fetched; anything else (including "word: ..." text) is raw text. */
function detectContentType(source: string): string {
  const trimmed = source.trim();
  if (!/^https?:\/\//i.test(trimmed) || /\s/.test(trimmed)) return "raw_text";
  try {
    new URL(trimmed);
    return "url";
  } catch {
    return "raw_text";
  }
}

// isYouTubeStrict + extractYouTubeId imported from parser.ts (single source of truth)

/**
 * Derive a clean title for a web page via LLM, given the HTML title, URL,
 * and first ~4k characters of the extracted text. Falls back to htmlTitle or
 * the first non-empty line of text.
 */
async function deriveWebTitle(
  htmlTitle: string | null,
  url: string,
  text: string
): Promise<string> {
  try {
    const { getOpenAIClient } = await import("../services/llm-client");
    const snippet = text.slice(0, 4000);
    const prompt = [
      `Given the following information about a web page, provide a concise, accurate title (under 120 characters). Reply with ONLY the title — no quotes, no explanation.`,
      `URL: ${url}`,
      htmlTitle ? `HTML <title>: ${htmlTitle}` : null,
      `Content excerpt:\n${snippet}`,
    ].filter(Boolean).join("\n");

    const completion = await getOpenAIClient().chat.completions.create({
      model: "google/gemini-2.5-flash",
      max_tokens: 80,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
    const result = (completion.choices[0]?.message?.content ?? "").trim();
    if (result.length > 5 && result.length < 200) return result;
  } catch {
    // LLM unavailable — use fallback chain
  }
  // Fallback: htmlTitle → first line of text → URL
  if (htmlTitle && htmlTitle.length > 5) return htmlTitle.slice(0, 200);
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  return lines[0]?.slice(0, 200) || url.slice(0, 100);
}

/**
 * Extract a human-readable title and description from content.
 *
 * - Books: the title found in the file (EPUB dc:title, PDF info Title, Project Gutenberg
 *   "Title:" header) when there is one.
 * - YouTube URLs: fetch real title via oEmbed (strict host check prevents false matches).
 * - Web pages: derive title with LLM from htmlTitle + URL + first 4k chars.
 * - Raw text: first non-empty line becomes the title.
 */
async function extractMetadata(
  source: string,
  text: string,
  htmlTitle?: string | null,
  knownTitle?: string
): Promise<{ title: string; description: string }> {
  const description = text.slice(0, 300).trim();

  if (knownTitle) return { title: knownTitle.slice(0, 300), description };

  // ── YouTube ──────────────────────────────────────────────────────────────────
  if (isYouTubeStrict(source)) {
    const videoId = extractYouTubeId(source);
    if (videoId) {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
        const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = await res.json() as { title?: string };
          if (data.title) return { title: data.title, description };
        }
      } catch {
        // oEmbed unavailable — fall through
      }
      // oEmbed failed: use LLM with available context
      return { title: await deriveWebTitle(null, source, text), description };
    }
  }

  // ── Web page (has htmlTitle from parser) ─────────────────────────────────────
  if (htmlTitle !== undefined) {
    return { title: await deriveWebTitle(htmlTitle, source, text), description };
  }

  // ── Raw text / PDF / uploaded file ───────────────────────────────────────────
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const title = lines[0]?.slice(0, 200) || source.slice(0, 100);
  return { title, description };
}

/** Validate caller-supplied verify config (types and ranges). Throws INVALID_CONFIG. */
export function validateConfig(config?: PoCWConfig): void {
  if (!config) return;
  const fail = (msg: string): never => { throw new PoCWError("INVALID_CONFIG", msg); };
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

  if (config.max_questions !== undefined) {
    if (!Number.isInteger(config.max_questions) || config.max_questions < 1 || config.max_questions > 50) {
      fail("max_questions must be an integer between 1 and 50");
    }
  }
  if (config.difficulty !== undefined) {
    if (!isNum(config.difficulty) || config.difficulty < 0 || config.difficulty > 1) {
      fail("difficulty must be a number between 0 and 1");
    }
  }
  if (config.threshold !== undefined) {
    if (!isNum(config.threshold) || config.threshold < 0 || config.threshold > 1) {
      fail("threshold must be a number between 0 and 1");
    }
  }
  if (config.difficulty_preset !== undefined && !["easy", "medium", "hard"].includes(config.difficulty_preset)) {
    fail("difficulty_preset must be one of: easy, medium, hard");
  }
  if (config.response !== undefined && !["boolean", "score", "detailed"].includes(config.response)) {
    fail("response must be one of: boolean, score, detailed");
  }
  if (config.q_types !== undefined) {
    if (!Array.isArray(config.q_types) || config.q_types.length === 0) {
      fail("q_types must be a non-empty array");
    }
    const valid = ["open", "mcq", "true_false"];
    for (const t of config.q_types) {
      if (!valid.includes(t)) fail(`Unknown question type: ${t}`);
    }
  }
  for (const key of ["model", "language", "persona"] as const) {
    const v = config[key];
    if (v !== undefined && (typeof v !== "string" || v.length > 200)) {
      fail(`${key} must be a string (max 200 characters)`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
