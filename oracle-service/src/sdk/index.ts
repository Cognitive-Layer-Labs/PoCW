/**
 * PoCW SDK — Main Entry Point
 *
 * Two primary operations:
 *   knowledge_id = await pocw.index(source)    // async, indexes in background
 *   result = await pocw.verify(id, subject)    // interactive verification session
 */

import { createHash } from "crypto";
import { parseContentToText, parseWebContentWithTitle, chunkText, isYouTubeStrict, extractYouTubeId } from "../services/parser";
import { extractKnowledgeGraph } from "../services/kg-builder";
import { storeGraph, graphExists, initFalkorDB, closeFalkorDB } from "../services/kg-store";
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
  AttestationResult,
  OnchainAttestation,
  OffchainAttestation,
  ChainConfig,
  QuestionType,
  PoCWError,
  PoCWErrorCode,
} from "./types";

const MAX_KG_CHUNKS = 15;

// 3.7 — LRU cache replaces unbounded Map to prevent OOM under heavy indexing load.
class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly maxSize: number) {}

  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      // Move to end (most-recently-used position)
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }

  set(k: K, v: V): void {
    if (this.map.has(k)) {
      this.map.delete(k);
    } else if (this.map.size >= this.maxSize) {
      // Evict least-recently-used (first entry)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(k, v);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Cached content text + chunks for indexed content (avoids re-parsing). LRU, max 100 entries. */
const contentCache = new LRUCache<string, { text: string; chunks: string[] }>(100);

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
   * Returns immediately — indexing happens in the background.
   * Idempotent: calling with the same source returns the existing entry.
   */
  async index(source: string): Promise<IndexResult> {
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

        const job = this.runIndexing(knowledgeId, retrySource, retryContentId);
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
    const contentType = detectContentType(source);

    // Insert as pending
    await insertContent(knowledgeId, contentType, source, numericId);
    await markIndexing(knowledgeId);

    // Start background indexing
    const job = this.runIndexing(knowledgeId, source, numericId);
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
    const { chunks } = await this.getContentChunks(knowledgeId, row.source);
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
    contentId: number
  ): Promise<void> {
    try {
      const contentType = detectContentType(source);
      let text: string;
      let htmlTitle: string | null = null;

      if (contentType === "raw_text") {
        text = source;
      } else if (contentType === "url") {
        // Use the title-aware parser for web URLs so extractMetadata can call
        // the LLM with the real HTML <title> tag (fixes "YouTube video <slug>" bug).
        const parsed = await parseWebContentWithTitle(source);
        text = parsed.text;
        htmlTitle = parsed.htmlTitle;
      } else {
        text = await parseContentToText(source);
      }

      const chunks = chunkText(text);
      const contentHash = createHash("sha256").update(text).digest("hex");

      // Build KG from sampled chunks
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
        for (const chunk of sampled) {
          const graph = await extractKnowledgeGraph(contentId, chunk);
          await storeGraph(graph);
        }
      }

      // Cache content for verify()
      contentCache.set(knowledgeId, { text, chunks });

      // Extract title/description — pass htmlTitle so LLM can use it for web pages
      const { title, description } = await extractMetadata(source, text, htmlTitle);
      await updateMetadata(knowledgeId, title, description);

      await markReady(knowledgeId, contentHash, chunks.length);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown indexing error";
      await markFailed(knowledgeId, message);
    }
  }

  private async getContentChunks(
    knowledgeId: string,
    source: string
  ): Promise<{ text: string; chunks: string[] }> {
    const cached = contentCache.get(knowledgeId);
    if (cached) return cached;

    // Re-parse if not cached (e.g., after restart)
    const text = detectContentType(source) === "raw_text"
      ? source
      : await parseContentToText(source);
    const chunks = chunkText(text);
    contentCache.set(knowledgeId, { text, chunks });
    return { text, chunks };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function detectContentType(source: string): string {
  if (source.startsWith("ipfs://")) return "cid";
  try {
    new URL(source);
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
 * - YouTube URLs: fetch real title via oEmbed (strict host check prevents false matches).
 * - Web pages: derive title with LLM from htmlTitle + URL + first 4k chars.
 * - Raw text: first non-empty line becomes the title.
 */
async function extractMetadata(
  source: string,
  text: string,
  htmlTitle?: string | null
): Promise<{ title: string; description: string }> {
  const description = text.slice(0, 300).trim();

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

function validateConfig(config?: PoCWConfig): void {
  if (!config) return;

  if (config.max_questions !== undefined) {
    if (config.max_questions < 1 || config.max_questions > 50) {
      throw new PoCWError("INVALID_CONFIG", "max_questions must be between 1 and 50");
    }
  }
  if (config.difficulty !== undefined) {
    if (config.difficulty < 0 || config.difficulty > 1) {
      throw new PoCWError("INVALID_CONFIG", "difficulty must be between 0 and 1");
    }
  }
  if (config.threshold !== undefined) {
    if (config.threshold < 0 || config.threshold > 1) {
      throw new PoCWError("INVALID_CONFIG", "threshold must be between 0 and 1");
    }
  }
  if (config.q_types) {
    const valid = ["open", "mcq", "true_false", "scenario"];
    for (const t of config.q_types) {
      if (!valid.includes(t)) {
        throw new PoCWError("INVALID_CONFIG", `Unknown question type: ${t}`);
      }
    }
  }
  if (config.attest === "onchain" && !config.chain) {
    throw new PoCWError("INVALID_CONFIG", "chain config required for on-chain attestation");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
