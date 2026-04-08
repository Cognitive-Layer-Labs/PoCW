import { expect } from "chai";
import Database from "better-sqlite3";
import {
  __setDbForTest,
  initContentStore,
  getContent,
  insertContent,
  markIndexing,
  markReady,
  markFailed,
  incrementUsage,
  closeContentStore,
} from "../src/sdk/content-store";

describe("Content Store (SQLite)", () => {
  let db: Database.Database;

  beforeEach(() => {
    // Use in-memory SQLite for tests
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.exec(`
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
    `);
    __setDbForTest(db);
  });

  afterEach(() => {
    __setDbForTest(null);
    db.close();
  });

  describe("insertContent()", () => {
    it("inserts a new content entry", () => {
      const inserted = insertContent("abc123", "url", "https://example.com", 42);
      expect(inserted).to.be.true;

      const row = getContent("abc123");
      expect(row).to.not.be.null;
      expect(row!.knowledge_id).to.equal("abc123");
      expect(row!.content_type).to.equal("url");
      expect(row!.source).to.equal("https://example.com");
      expect(row!.content_id).to.equal(42);
      expect(row!.status).to.equal("pending");
    });

    it("is idempotent — second insert returns false", () => {
      insertContent("abc123", "url", "https://example.com", 42);
      const second = insertContent("abc123", "url", "https://example.com", 42);
      expect(second).to.be.false;
    });
  });

  describe("getContent()", () => {
    it("returns null for non-existent entry", () => {
      expect(getContent("nonexistent")).to.be.null;
    });
  });

  describe("status transitions", () => {
    beforeEach(() => {
      insertContent("k1", "url", "https://test.com", 1);
    });

    it("pending → indexing", () => {
      markIndexing("k1");
      expect(getContent("k1")!.status).to.equal("indexing");
    });

    it("indexing → ready", () => {
      markIndexing("k1");
      markReady("k1", "hash123", 10);
      const row = getContent("k1")!;
      expect(row.status).to.equal("ready");
      expect(row.content_hash).to.equal("hash123");
      expect(row.chunk_count).to.equal(10);
      expect(row.indexed_at).to.not.be.null;
    });

    it("indexing → failed", () => {
      markIndexing("k1");
      markFailed("k1", "Parse error");
      const row = getContent("k1")!;
      expect(row.status).to.equal("failed");
      expect(row.error).to.equal("Parse error");
    });
  });

  describe("incrementUsage()", () => {
    it("increments usage count and sets last_used_at", () => {
      insertContent("k1", "url", "https://test.com", 1);
      incrementUsage("k1");
      const row1 = getContent("k1")!;
      expect(row1.usage_count).to.equal(1);
      expect(row1.last_used_at).to.not.be.null;

      incrementUsage("k1");
      expect(getContent("k1")!.usage_count).to.equal(2);
    });
  });
});
