import { expect } from "chai";
import Database from "better-sqlite3";
import {
  __setDbForTest,
  getContent,
  insertContent,
  markIndexing,
  markReady,
  markFailed,
  incrementUsage,
  listContent,
  setVisibility,
  deleteContent,
  wipeAllContent,
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
        last_used_at  TEXT,
        hidden        INTEGER DEFAULT 0
      );
    `);
    __setDbForTest(db);
  });

  afterEach(() => {
    __setDbForTest(null);
    db.close();
  });

  describe("insertContent()", () => {
    it("inserts a new content entry", async () => {
      const inserted = await insertContent("abc123", "url", "https://example.com", 42);
      expect(inserted).to.be.true;

      const row = getContent("abc123");
      expect(row).to.not.be.null;
      expect(row!.knowledge_id).to.equal("abc123");
      expect(row!.content_type).to.equal("url");
      expect(row!.source).to.equal("https://example.com");
      expect(row!.content_id).to.equal(42);
      expect(row!.status).to.equal("pending");
    });

    it("is idempotent — second insert returns false", async () => {
      await insertContent("abc123", "url", "https://example.com", 42);
      const second = await insertContent("abc123", "url", "https://example.com", 42);
      expect(second).to.be.false;
    });
  });

  describe("getContent()", () => {
    it("returns null for non-existent entry", () => {
      expect(getContent("nonexistent")).to.be.null;
    });
  });

  describe("status transitions", () => {
    beforeEach(async () => {
      await insertContent("k1", "url", "https://test.com", 1);
    });

    it("pending → indexing", async () => {
      await markIndexing("k1");
      expect(getContent("k1")!.status).to.equal("indexing");
    });

    it("indexing → ready", async () => {
      await markIndexing("k1");
      await markReady("k1", "hash123", 10);
      const row = getContent("k1")!;
      expect(row.status).to.equal("ready");
      expect(row.content_hash).to.equal("hash123");
      expect(row.chunk_count).to.equal(10);
      expect(row.indexed_at).to.not.be.null;
    });

    it("indexing → failed", async () => {
      await markIndexing("k1");
      await markFailed("k1", "Parse error");
      const row = getContent("k1")!;
      expect(row.status).to.equal("failed");
      expect(row.error).to.equal("Parse error");
    });
  });

  describe("incrementUsage()", () => {
    it("increments usage count and sets last_used_at", async () => {
      await insertContent("k1", "url", "https://test.com", 1);
      await incrementUsage("k1");
      const row1 = getContent("k1")!;
      expect(row1.usage_count).to.equal(1);
      expect(row1.last_used_at).to.not.be.null;

      await incrementUsage("k1");
      expect(getContent("k1")!.usage_count).to.equal(2);
    });
  });

  describe("setVisibility() + listContent() hidden filter", () => {
    beforeEach(async () => {
      await insertContent("vis1", "url", "https://a.com", 1);
      await insertContent("vis2", "url", "https://b.com", 2);
    });

    it("hides an entry from the default catalog but keeps it for admin", async () => {
      await setVisibility("vis1", true);
      expect(getContent("vis1")!.hidden).to.equal(1);

      const publicIds = listContent().rows.map((r) => r.knowledge_id);
      expect(publicIds).to.not.include("vis1");
      expect(publicIds).to.include("vis2");

      const adminIds = listContent({ includeHidden: true }).rows.map((r) => r.knowledge_id);
      expect(adminIds).to.include("vis1");
    });

    it("unhides an entry", async () => {
      await setVisibility("vis1", true);
      await setVisibility("vis1", false);
      expect(getContent("vis1")!.hidden).to.equal(0);
      expect(listContent().rows.map((r) => r.knowledge_id)).to.include("vis1");
    });
  });

  describe("deleteContent()", () => {
    it("removes a single entry and returns true", async () => {
      await insertContent("del1", "url", "https://a.com", 1);
      const removed = await deleteContent("del1");
      expect(removed).to.be.true;
      expect(getContent("del1")).to.be.null;
    });

    it("returns false when nothing was deleted", async () => {
      expect(await deleteContent("missing")).to.be.false;
    });
  });

  describe("wipeAllContent()", () => {
    it("removes every entry and returns the count", async () => {
      await insertContent("w1", "url", "https://a.com", 1);
      await insertContent("w2", "url", "https://b.com", 2);
      const count = await wipeAllContent();
      expect(count).to.equal(2);
      expect(listContent({ includeHidden: true }).total).to.equal(0);
    });
  });
});
