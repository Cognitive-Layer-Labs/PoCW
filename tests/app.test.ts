import { expect } from "chai";
import type { AddressInfo } from "net";
import type { Server } from "http";
import app, { parseTrustProxy, setPoCWInstance } from "../src/app";
import { PoCWError } from "../src/sdk/types";

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
    async index(source: string, opts?: { asText?: boolean }) {
      return { knowledgeId: opts?.asText ? "text-id" : "url-id", status: "indexing", contentId: 1, source };
    },
    listContent() {
      return { rows: [], total: 0 };
    },
    async wipeAll() {
      return { contentRemoved: 0, nodesRemoved: 0 };
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

  it("POST /api/verify validates knowledgeId and subject types", async () => {
    expect((await post("/api/verify", {})).status).to.equal(400);
    expect((await post("/api/verify", { knowledgeId: "k", subject: 42 })).status).to.equal(400);
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
