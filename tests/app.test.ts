import { expect } from "chai";
import type { AddressInfo } from "net";
import type { Server } from "http";
import app, { parseTrustProxy, setPoCWInstance } from "../src/app";
import { PoCWError } from "../src/sdk/types";
import { validateConfig } from "../src/sdk/index";
import Database from "better-sqlite3";
import { __setDbForTest, insertContent, updateMetadata } from "../src/sdk/content-store";
import { makeEpub } from "./helpers/fixtures";
import { recordCall, recordSessionFinished } from "../src/services/usage-store";
import { __setKeyStatusFetchForTest, KEY_STATUS_URL } from "../src/services/openrouter-key";

/**
 * HTTP-layer tests (no FalkorDB/Redis): auth, admin gating, rate limiting, input validation.
 * A minimal fake PoCW instance stands in for the SDK.
 */
describe("HTTP API", function () {
  this.timeout(20000);

  let server: Server;
  let base: string;
  const savedEnv = { ...process.env };

  const fakePoCW = {
    getIndexStatus(id: string) {
      if (id === "missing") throw new PoCWError("CONTENT_NOT_FOUND", "nope");
      return { knowledgeId: id, status: id === "busy" ? "indexing" : id === "bad" ? "failed" : "ready", contentId: 7 };
    },
    lastIndex: undefined as { source: string; opts?: { asText?: boolean; meta?: Record<string, unknown> } } | undefined,
    async index(source: string, opts?: { asText?: boolean; meta?: Record<string, unknown> }) {
      fakePoCW.lastIndex = { source, opts };
      return { knowledgeId: opts?.asText ? "text-id" : "url-id", status: "indexing", contentId: 1 };
    },
    listContent() {
      return { rows: [], total: 0 };
    },
    async wipeAll() {
      return { contentRemoved: 0, nodesRemoved: 0 };
    },
    lastVerifyConfig: undefined as Record<string, unknown> | undefined,
    getContentChunks: async (_id: string) => ({ text: "", chunks: [] as string[] }),
    async verify(_id: string, _subject: string, config: Record<string, unknown>) {
      fakePoCW.lastVerifyConfig = config;
      throw new PoCWError("CONTENT_NOT_FOUND", "stop after capturing config");
    },
  };

  before(async () => {
    setPoCWInstance(fakePoCW as any);
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    process.env = savedEnv;
    await new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(() => {
    delete process.env.POCW_API_KEY;
    delete process.env.ADMIN_API_KEY;
  });

  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("serves /health without auth", async () => {
    process.env.POCW_API_KEY = "secret";
    const res = await get("/health");
    expect(res.status).to.equal(200);
    expect((await res.json()).status).to.equal("ok");
  });

  it("requires the bearer POCW_API_KEY on /api/* when configured", async () => {
    process.env.POCW_API_KEY = "secret";
    expect((await get("/api/index")).status).to.equal(401);
    expect((await get("/api/index", { Authorization: "Bearer wrong" })).status).to.equal(401);
    expect((await get("/api/index", { Authorization: "Bearer secretX" })).status).to.equal(401);
    expect((await get("/api/index", { Authorization: "Bearer secret" })).status).to.equal(200);
  });

  it("admin API is disabled (403) when ADMIN_API_KEY is unset — even with the API key", async () => {
    process.env.POCW_API_KEY = "secret";
    const res = await post("/api/admin/wipe", {}, { Authorization: "Bearer secret" });
    expect(res.status).to.equal(403);
  });

  it("admin API requires ADMIN_API_KEY, not POCW_API_KEY", async () => {
    process.env.POCW_API_KEY = "secret";
    process.env.ADMIN_API_KEY = "admin-secret";
    expect((await post("/api/admin/wipe", {}, { Authorization: "Bearer secret" })).status).to.equal(401);
    const ok = await post("/api/admin/wipe", {}, { Authorization: "Bearer admin-secret" });
    expect(ok.status).to.equal(200);
    expect((await ok.json()).wiped).to.equal(true);
  });

  it("index status: 202 + Retry-After while indexing, 200 when ready or failed, 404 when unknown", async () => {
    const busy = await get("/api/index/busy");
    expect(busy.status).to.equal(202);
    expect(busy.headers.get("retry-after")).to.equal("5");
    expect((await busy.json()).status).to.equal("indexing");

    expect((await get("/api/index/ok")).status).to.equal(200);
    const failed = await get("/api/index/bad");
    expect(failed.status).to.equal(200);
    expect((await failed.json()).status).to.equal("failed");
    expect((await get("/api/index/missing")).status).to.equal(404);
  });

  it("POST /api/index only accepts http(s) sources", async () => {
    expect((await post("/api/index", { source: "ipfs://Qm123" })).status).to.equal(400);
    expect((await post("/api/index", { source: "file:///etc/passwd" })).status).to.equal(400);
    expect((await post("/api/index", {})).status).to.equal(400);
    const ok = await post("/api/index", { source: "https://example.com/a" });
    expect(ok.status).to.equal(202);
    expect((await ok.json()).knowledgeId).to.equal("url-id");
  });

  it("POST /api/upload always indexes the body as text (never as a URL/file path)", async () => {
    const res = await fetch(base + "/api/upload", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "file:///etc/passwd",
    });
    expect(res.status).to.equal(202);
    expect((await res.json()).knowledgeId).to.equal("text-id");

    const bin = await fetch(base + "/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from([0x00, 0x01, 0x02, 0x03]),
    });
    expect(bin.status).to.equal(415);

    const wrongType = await fetch(base + "/api/upload", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: Buffer.from("x"),
    });
    expect(wrongType.status).to.equal(415);
  });

  it("POST /api/upload accepts EPUB (application/epub+zip or sniffed octet-stream) with its metadata", async () => {
    for (const ct of ["application/epub+zip", "application/octet-stream"]) {
      const res = await fetch(base + "/api/upload", { method: "POST", headers: { "Content-Type": ct }, body: makeEpub() });
      expect(res.status, ct).to.equal(202);
      expect(fakePoCW.lastIndex!.opts).to.deep.equal({ asText: true, meta: { title: "The Test Book", author: "Jane Author" } });
      expect(fakePoCW.lastIndex!.source).to.contain("bright cold day");
    }
  });

  it("POST /api/upload accepts books up to 40 MB and answers 413 above", async () => {
    const big = Buffer.alloc(12 * 1024 * 1024, "book text ");
    expect((await fetch(base + "/api/upload", { method: "POST", headers: { "Content-Type": "text/plain" }, body: big })).status).to.equal(202);
    const tooBig = Buffer.alloc(40 * 1024 * 1024 + 1024, "a");
    const res = await fetch(base + "/api/upload", { method: "POST", headers: { "Content-Type": "text/plain" }, body: tooBig });
    expect(res.status).to.equal(413);
  });

  it("GET /api/index/:id includes the author when one was detected", async () => {
    const db = new Database(":memory:");
    __setDbForTest(db);
    try {
      db.exec(`CREATE TABLE content_index (knowledge_id TEXT PRIMARY KEY, content_type TEXT NOT NULL, source TEXT NOT NULL,
        title TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT, content_id INTEGER, content_hash TEXT,
        chunk_count INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), indexed_at TEXT,
        usage_count INTEGER DEFAULT 0, last_used_at TEXT)`);
      __setDbForTest(db); // migrate the fresh table (adds hidden/author)
      await insertContent("ok", "raw_text", "text", 7);
      await updateMetadata("ok", "Pride and Prejudice", "", "Jane Austen");
      const body = await (await get("/api/index/ok")).json();
      expect(body).to.include({ title: "Pride and Prejudice", author: "Jane Austen" });
      expect(body).to.not.have.property("source"); // uploads are not echoed back
    } finally {
      __setDbForTest(null);
      db.close();
    }
  });

  it("GET /api/index/:id/text returns the full extracted text, 404 for unknown ids", async () => {
    const db = new Database(":memory:");
    __setDbForTest(db);
    try {
      db.exec(`CREATE TABLE content_index (knowledge_id TEXT PRIMARY KEY, content_type TEXT NOT NULL, source TEXT NOT NULL,
        title TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT, content_id INTEGER, content_hash TEXT,
        chunk_count INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), indexed_at TEXT,
        usage_count INTEGER DEFAULT 0, last_used_at TEXT)`);
      __setDbForTest(db);
      await insertContent("book", "raw_text", "stored", 9);
      fakePoCW.getContentChunks = async (id: string) => ({ text: `Full text of ${id}`, chunks: [] });
      const res = await get("/api/index/book/text");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.match(/^text\/plain/);
      expect(await res.text()).to.equal("Full text of book");
      const missing = await get("/api/index/nope/text");
      expect(missing.status).to.equal(404);
      expect(await missing.json()).to.include({ code: "CONTENT_NOT_FOUND" });
    } finally {
      __setDbForTest(null);
      db.close();
    }
  });

  it("POST /api/verify validates knowledgeId and subject types", async () => {
    expect((await post("/api/verify", {})).status).to.equal(400);
    expect((await post("/api/verify", { knowledgeId: "k", subject: 42 })).status).to.equal(400);
    expect((await post("/api/verify", { knowledgeId: "k", config: [1] })).status).to.equal(400);
  });

  it("ignores a caller-chosen LLM model unless ALLOW_MODEL_OVERRIDE=true", async () => {
    const res = await post("/api/verify", {
      knowledgeId: "k",
      config: { model: "some/expensive-model", max_questions: 5 },
    });
    expect(res.status).to.equal(404);
    expect(fakePoCW.lastVerifyConfig).to.deep.equal({ max_questions: 5 });
  });

  it("rejects verify configs with wrong types or out-of-range values", () => {
    for (const config of [
      { max_questions: "9" }, { max_questions: 2.5 }, { threshold: "0.5" }, { q_types: "open" },
      { q_types: [] }, { response: "verbose" }, { difficulty_preset: "insane" }, { model: 123 },
    ]) {
      expect(() => validateConfig(config as any), JSON.stringify(config)).to.throw(PoCWError);
    }
    expect(() => validateConfig({ max_questions: 5, q_types: ["mcq"], threshold: 0.6, response: "detailed" })).not.to.throw();
  });

  it("returns JSON 404 for unknown API routes and JSON 400 for malformed JSON", async () => {
    const nf = await get("/api/does-not-exist");
    expect(nf.status).to.equal(404);
    expect((await nf.json()).code).to.equal("NOT_FOUND");

    const bad = await fetch(base + "/api/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(bad.status).to.equal(400);
    expect((await bad.json()).error).to.be.a("string");
  });

  it("GET /api/usage: needs the API key; returns key status, totals, byDay, byTask, perBook, perSession", async () => {
    const db = new Database(":memory:");
    __setDbForTest(db);
    const keyCalls: string[] = [];
    __setKeyStatusFetchForTest(async (url, init) => {
      keyCalls.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      return new Response(JSON.stringify({ data: { limit: 6, usage: 1.25, limit_remaining: 4.75 } }), { status: 200 });
    });
    process.env.OPENROUTER_API_KEY = "or-key";
    try {
      recordCall({ task: "kg", model: "anthropic/claude-haiku-5.5", costUsd: 0.004, latencyMs: 1200, ok: true, knowledgeId: "A" });
      recordCall({ task: "grade", model: "typesafe/jev-1.13-20260917", costUsd: 0.00002, latencyMs: 300, ok: true, sessionId: "s1" });
      recordCall({ task: "grade_escalation", model: "openai/gpt-6-luna", latencyMs: 900, ok: false, error: "x", sessionId: "s1" });
      recordSessionFinished("s1", "A");

      process.env.POCW_API_KEY = "secret";
      expect((await get("/api/usage")).status).to.equal(401);
      const res = await get("/api/usage?days=7", { Authorization: "Bearer secret" });
      expect(res.status).to.equal(200);
      expect(res.headers.get("cache-control")).to.equal("no-store");
      const body = await res.json();
      expect(body.key).to.deep.equal({ limitUsd: 6, usageUsd: 1.25, remainingUsd: 4.75 });
      expect(body.totals).to.deep.equal({ calls: 3, costUsd: 0.00402, errors: 1 });
      expect(body.byDay).to.have.length(7);
      expect(body.byDay[6]).to.deep.equal({ date: new Date().toISOString().slice(0, 10), calls: 3, costUsd: 0.00402 });
      expect(body.byTask.map((t: { task: string }) => t.task)).to.deep.equal(["kg", "grade", "grade_escalation"]);
      expect(body.byTask[2]).to.deep.equal({ task: "grade_escalation", model: "openai/gpt-6-luna", calls: 1, costUsd: 0, avgLatencyMs: 900, errors: 1 });
      expect(body.perBook).to.deep.equal({ avgCostUsd: 0.004, count: 1 });
      expect(body.perSession).to.deep.equal({ avgCostUsd: 0.00002, count: 1 });

      // key status is cached (~60 s); days is clamped to 1–90
      const again = await (await get("/api/usage?days=999", { Authorization: "Bearer secret" })).json();
      expect(again.byDay).to.have.length(90);
      expect(keyCalls).to.deep.equal([`${KEY_STATUS_URL} Bearer or-key`]);
    } finally {
      __setKeyStatusFetchForTest(async () => new Response("network disabled in tests", { status: 400 }));
      delete process.env.OPENROUTER_API_KEY;
      __setDbForTest(null);
      db.close();
    }
  });

  it("status polling does not consume the main rate-limit budget", async () => {
    // 40 polls > the main limit of 30/min, but polls have their own (120/min) budget.
    for (let i = 0; i < 40; i++) {
      const res = await get("/api/index/busy");
      expect(res.status, `poll #${i + 1}`).to.equal(202);
    }
  });

  it("main limiter returns 429 after 30 requests/min from one client", async () => {
    let limited = false;
    for (let i = 0; i < 35 && !limited; i++) {
      const res = await get("/api/index");
      if (res.status === 429) {
        limited = true;
        expect((await res.json()).code).to.equal("CAPACITY_EXCEEDED");
      }
    }
    expect(limited).to.equal(true);
  });

  it("parses TRUST_PROXY", () => {
    expect(parseTrustProxy(undefined)).to.equal(false);
    expect(parseTrustProxy("")).to.equal(false);
    expect(parseTrustProxy("false")).to.equal(false);
    expect(parseTrustProxy("0")).to.equal(0);
    expect(parseTrustProxy("1")).to.equal(1);
    expect(parseTrustProxy("true")).to.equal(true);
    expect(parseTrustProxy("loopback, 10.0.0.0/8")).to.equal("loopback, 10.0.0.0/8");
  });
});
