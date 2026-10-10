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
import { attachUsageStore } from "../services/usage-store";

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

// Migrations: columns added after the first schema version, added when missing.
// (Databases created by older versions may carry extra legacy columns; they are ignored.)
const ADDED_COLUMNS: Array<[string, string]> = [
  ["title", "TEXT"],
  ["description", "TEXT"],
  ["hidden", "INTEGER DEFAULT 0"],
  ["author", "TEXT"],
];

// Columns exposed as ContentRow. Selected explicitly so legacy columns present in databases
// created by older versions never leak into API responses.
const ROW_COLUMNS = [
  "knowledge_id", "content_type", "source", "title", "description", "status", "error",
  "content_id", "content_hash", "chunk_count", "created_at", "indexed_at", "usage_count",
  "last_used_at", "hidden", "author",
].join(", ");

// Listing variant: uploads are stored as their full extracted text (whole books, up to millions
// of characters), so list queries only load the first 301 characters of raw-text sources.
const LIST_COLUMNS = ROW_COLUMNS.replace(
  /\bsource\b/,
  "CASE WHEN content_type = 'raw_text' THEN substr(source, 1, 301) ELSE source END AS source",
);

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
  openContentStore(dbPath);
  // LLM / decisions call log lives in the same database (migrated + pruned on attach). Only an
  // explicit init (PoCW.init at engine startup) attaches it — a lazy open by getDb() does not.
  attachUsageStore(db);
}

function openContentStore(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLE);
  migrate(db);
}

/** Idempotent schema migration: add the columns introduced after the first schema version. */
function migrate(database: Database.Database): void {
  const existing = new Set(
    (database.prepare("PRAGMA table_info(content_index)").all() as Array<{ name: string }>).map(c => c.name)
  );
  if (existing.size === 0) return; // table not created yet (injected test databases)
  for (const [name, type] of ADDED_COLUMNS) {
    if (!existing.has(name)) database.exec(`ALTER TABLE content_index ADD COLUMN ${name} ${type}`);
  }
}

/** Get the database instance, initializing if needed. */
function getDb(): Database.Database {
  if (!db) openContentStore(path.resolve(process.cwd(), "data", "pocw.db"));
  return db!;
}

/**
 * Get a content entry by knowledge ID.
 */
export function getContent(knowledgeId: string): ContentRow | null {
  const row = getDb()
    .prepare(`SELECT ${ROW_COLUMNS} FROM content_index WHERE knowledge_id = ?`)
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
 * Update title and description (and, when given, author) for a knowledge ID.
 * `author` undefined leaves the stored author untouched; null clears it.
 */
export async function updateMetadata(
  knowledgeId: string,
  title: string,
  description: string,
  author?: string | null
): Promise<void> {
  return runSerialized(() => {
    if (author === undefined) {
      getDb()
        .prepare("UPDATE content_index SET title = ?, description = ? WHERE knowledge_id = ?")
        .run(title, description, knowledgeId);
    } else {
      getDb()
        .prepare("UPDATE content_index SET title = ?, description = ?, author = ? WHERE knowledge_id = ?")
        .run(title, description, author, knowledgeId);
    }
  });
}

/**
 * Show or hide a content entry from the public catalog (admin visibility toggle).
 * Hidden entries stay fully indexed but are excluded from listContent by default.
 */
export async function setVisibility(knowledgeId: string, hidden: boolean): Promise<void> {
  return runSerialized(() => {
    getDb()
      .prepare("UPDATE content_index SET hidden = ? WHERE knowledge_id = ?")
      .run(hidden ? 1 : 0, knowledgeId);
  });
}

/**
 * Delete a content entry from the catalog. Returns true if a row was removed.
 * Caller cascades to FalkorDB (deleteGraph) and the in-memory content cache.
 */
export async function deleteContent(knowledgeId: string): Promise<boolean> {
  return runSerialized(() => {
    const result = getDb()
      .prepare("DELETE FROM content_index WHERE knowledge_id = ?")
      .run(knowledgeId);
    return result.changes > 0;
  });
}

/**
 * Delete ALL content entries (full reset). Returns the number of rows removed.
 * Caller cascades to FalkorDB (wipeAllGraphs) and clears the content cache.
 */
export async function wipeAllContent(): Promise<number> {
  return runSerialized(() => {
    const result = getDb().prepare("DELETE FROM content_index").run();
    return result.changes;
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
  /** Include hidden entries (admin views). Default false → public catalog excludes hidden. */
  includeHidden?: boolean;
}): { rows: ContentRow[]; total: number } {
  const { status, limit = 50, offset = 0, includeHidden = false } = options || {};
  const db = getDb();

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  // Legacy rows predate the `hidden` column → NULL is treated as visible.
  if (!includeHidden) conditions.push("(hidden IS NULL OR hidden = 0)");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const total = db
    .prepare(`SELECT COUNT(*) as count FROM content_index ${where}`)
    .get(...params) as { count: number };

  const rows = db
    .prepare(`SELECT ${LIST_COLUMNS} FROM content_index ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
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
    attachUsageStore(null);
    db.close();
    db = null;
  }
}

/** For testing: override the database instance (migrated like a real one). */
export function __setDbForTest(testDb: Database.Database | null): void {
  db = testDb;
  if (testDb) migrate(testDb);
  attachUsageStore(testDb);
}
