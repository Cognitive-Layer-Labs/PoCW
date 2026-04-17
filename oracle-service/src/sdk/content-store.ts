/**
 * SQLite Content Index Store
 *
 * Tracks content indexing status, metadata, and usage for the PoCW SDK.
 * Uses better-sqlite3 for synchronous, zero-config embedded storage.
 *
 * WS4: All mutating calls are serialized through a single Promise chain
 * to prevent SQLITE_BUSY under concurrent indexing load.
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { ContentRow, IndexStatus } from "./types";

let db: Database.Database | null = null;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS content_index (
  knowledge_id  TEXT PRIMARY KEY,
  content_type  TEXT NOT NULL,
  source        TEXT NOT NULL,
  title         TEXT,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  content_id    INTEGER,
  content_hash  TEXT,
  chunk_count   INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  indexed_at    TEXT,
  usage_count   INTEGER DEFAULT 0,
  last_used_at  TEXT
);
`;

// Migration: add title/description columns if they don't exist
const ADD_TITLE_DESC = `
ALTER TABLE content_index ADD COLUMN title TEXT;
ALTER TABLE content_index ADD COLUMN description TEXT;
`;

// ─── Write Queue — serializes all mutating calls to prevent SQLITE_BUSY ──

let writeChain: Promise<unknown> = Promise.resolve();

export async function runSerialized<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = writeChain.then(() => fn());
  writeChain = result.catch(() => {});
  return result;
}

/**
 * Initialize the SQLite content store.
 * Creates the database file and table if they don't exist.
 */
export function initContentStore(
  dbPath: string = path.resolve(process.cwd(), "data", "pocw.db")
): void {
  if (db) return;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLE);

  // Add title/description columns if they don't exist (idempotent)
  try {
    db.exec(ADD_TITLE_DESC);
  } catch {
    // Columns already exist — ignore
  }
}

/** Get the database instance, initializing if needed. */
function getDb(): Database.Database {
  if (!db) initContentStore();
  return db!;
}

/**
 * Get a content entry by knowledge ID.
 */
export function getContent(knowledgeId: string): ContentRow | null {
  const row = getDb()
    .prepare("SELECT * FROM content_index WHERE knowledge_id = ?")
    .get(knowledgeId) as ContentRow | undefined;
  return row ?? null;
}

/**
 * Insert a new content entry. Returns false if already exists (idempotent).
 */
export async function insertContent(
  knowledgeId: string,
  contentType: string,
  source: string,
  contentId: number
): Promise<boolean> {
  return runSerialized(() => {
    const stmt = getDb().prepare(`
      INSERT OR IGNORE INTO content_index (knowledge_id, content_type, source, content_id, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);
    const result = stmt.run(knowledgeId, contentType, source, contentId);
    return result.changes > 0;
  });
}

/**
 * Mark content as "indexing" (KG build in progress).
 */
export async function markIndexing(knowledgeId: string): Promise<void> {
  return runSerialized(() => {
    getDb()
      .prepare("UPDATE content_index SET status = 'indexing', error = NULL WHERE knowledge_id = ?")
      .run(knowledgeId);
  });
}

/**
 * Mark content as "ready" (KG build complete).
 */
export async function markReady(
  knowledgeId: string,
  contentHash: string,
  chunkCount: number
): Promise<void> {
  return runSerialized(() => {
    getDb()
      .prepare(`
        UPDATE content_index
        SET status = 'ready', content_hash = ?, chunk_count = ?, indexed_at = datetime('now')
        WHERE knowledge_id = ?
      `)
      .run(contentHash, chunkCount, knowledgeId);
  });
}

/**
 * Update title and description for a knowledge ID.
 */
export async function updateMetadata(
  knowledgeId: string,
  title: string,
  description: string
): Promise<void> {
  return runSerialized(() => {
    getDb()
      .prepare("UPDATE content_index SET title = ?, description = ? WHERE knowledge_id = ?")
      .run(title, description, knowledgeId);
  });
}

/**
 * List all indexed content, ordered by most recent.
 * Returns paginated results.
 */
export function listContent(options?: {
  status?: string;
  limit?: number;
  offset?: number;
}): { rows: ContentRow[]; total: number } {
  const { status, limit = 50, offset = 0 } = options || {};
  const db = getDb();

  const where = status ? "WHERE status = ?" : "";
  const params = status ? [status] : [];

  const total = db
    .prepare(`SELECT COUNT(*) as count FROM content_index ${where}`)
    .get(...params) as { count: number };

  const rows = db
    .prepare(`SELECT * FROM content_index ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ContentRow[];

  return { rows, total: total.count };
}

/**
 * Mark content as "failed" with error message.
 */
export async function markFailed(knowledgeId: string, error: string): Promise<void> {
  return runSerialized(() => {
    getDb()
      .prepare("UPDATE content_index SET status = 'failed', error = ? WHERE knowledge_id = ?")
      .run(error, knowledgeId);
  });
}

/**
 * Increment usage count and update last_used_at.
 */
export async function incrementUsage(knowledgeId: string): Promise<void> {
  return runSerialized(() => {
    getDb()
      .prepare(`
        UPDATE content_index
        SET usage_count = usage_count + 1, last_used_at = datetime('now')
        WHERE knowledge_id = ?
      `)
      .run(knowledgeId);
  });
}

/**
 * 3.1 — Stuck-job recovery.
 */
export async function recoverStuckIndexingJobs(timeoutMinutes = 15): Promise<number> {
  return runSerialized(() => {
    const result = getDb()
      .prepare(`
        UPDATE content_index
        SET status = 'failed', error = 'Indexing interrupted by server restart'
        WHERE status = 'indexing'
          AND created_at < datetime('now', ?)
      `)
      .run(`-${timeoutMinutes} minutes`);
    return result.changes;
  });
}

/**
 * Close the SQLite connection.
 */
export function closeContentStore(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** For testing: override the database instance */
export function __setDbForTest(testDb: Database.Database | null): void {
  db = testDb;
}
