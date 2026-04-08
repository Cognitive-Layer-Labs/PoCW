/**
 * PoCW SDK — Main Entry Point
 *
 * Two primary operations:
 *   knowledge_id = await pocw.index(source)    // async, indexes in background
 *   result = await pocw.verify(id, subject)    // interactive verification session
 */

import { createHash } from "crypto";
import { parseContentToText, chunkText } from "../services/parser";
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

/** Cached content text + chunks for indexed content (avoids re-parsing) */
const contentCache = new Map<string, { text: string; chunks: string[] }>();

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
    const numericId = contentUrlToId(source);

    // Check if already indexed
    const existing = getContent(knowledgeId);
    if (existing) {
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
    insertContent(knowledgeId, contentType, source, numericId);
    markIndexing(knowledgeId);

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
      const text = await parseContentToText(source);
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

      markReady(knowledgeId, contentHash, chunks.length);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown indexing error";
      markFailed(knowledgeId, message);
    }
  }

  private async getContentChunks(
    knowledgeId: string,
    source: string
  ): Promise<{ text: string; chunks: string[] }> {
    const cached = contentCache.get(knowledgeId);
    if (cached) return cached;

    // Re-parse if not cached (e.g., after restart)
    const text = await parseContentToText(source);
    const chunks = chunkText(text);
    contentCache.set(knowledgeId, { text, chunks });
    return { text, chunks };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeKnowledgeId(source: string): string {
  const normalized = source.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
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
