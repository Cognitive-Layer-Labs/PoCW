/**
 * SQLite Content Index Store
 *
 * Tracks content indexing status, metadata, and usage for the PoCW SDK.
 * Uses better-sqlite3 for synchronous, zero-config embedded storage.
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

/**
 * Initialize the SQLite content store.
 * Creates the database file and table if they don't exist.
 */
export function initContentStore(
  dbPath: string = path.resolve(process.cwd(), "data", "pocw.db")
): void {
  if (db) return;

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLE);
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
export function insertContent(
  knowledgeId: string,
  contentType: string,
  source: string,
  contentId: number
): boolean {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO content_index (knowledge_id, content_type, source, content_id, status)
    VALUES (?, ?, ?, ?, 'pending')
  `);
  const result = stmt.run(knowledgeId, contentType, source, contentId);
  return result.changes > 0;
}

/**
 * Mark content as "indexing" (KG build in progress).
 */
export function markIndexing(knowledgeId: string): void {
  getDb()
    .prepare("UPDATE content_index SET status = 'indexing' WHERE knowledge_id = ?")
    .run(knowledgeId);
}

/**
 * Mark content as "ready" (KG build complete).
 */
export function markReady(
  knowledgeId: string,
  contentHash: string,
  chunkCount: number
): void {
  getDb()
    .prepare(`
      UPDATE content_index
      SET status = 'ready', content_hash = ?, chunk_count = ?, indexed_at = datetime('now')
      WHERE knowledge_id = ?
    `)
    .run(contentHash, chunkCount, knowledgeId);
}

/**
 * Mark content as "failed" with error message.
 */
export function markFailed(knowledgeId: string, error: string): void {
  getDb()
    .prepare("UPDATE content_index SET status = 'failed', error = ? WHERE knowledge_id = ?")
    .run(error, knowledgeId);
}

/**
 * Increment usage count and update last_used_at.
 */
export function incrementUsage(knowledgeId: string): void {
  getDb()
    .prepare(`
      UPDATE content_index
      SET usage_count = usage_count + 1, last_used_at = datetime('now')
      WHERE knowledge_id = ?
    `)
    .run(knowledgeId);
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
