import { expect } from "chai";
import Database from "better-sqlite3";

import {
  attachUsageStore,
  getUsageSummary,
  recordCall,
  recordSessionFinished,
  setCallOutcome,
  migrateUsageTables,
  __usageDbForTest,
} from "../src/services/usage-store";
import { runWithUsageContext } from "../src/services/usage-context";
import { chatCompletion } from "../src/services/llm-client";
import { parseKeyStatus } from "../src/services/openrouter-key";
import { stubChat, restoreChat } from "./helpers/model-stubs";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const day = (d: string, h = "10:00:00") => new Date(`${d}T${h}.000Z`);

describe("Usage log (usage-store.ts)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    attachUsageStore(db, NOW);
  });
  afterEach(() => {
    restoreChat();
    attachUsageStore(null);
    db.close();
  });

  it("creates its tables idempotently and adds missing columns to an older table", () => {
    const legacy = new Database(":memory:");
    legacy.exec("CREATE TABLE llm_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, task TEXT NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, latency_ms INTEGER, ok INTEGER NOT NULL, error TEXT)");
    migrateUsageTables(legacy);
    migrateUsageTables(legacy);
    const cols = (legacy.prepare("PRAGMA table_info(llm_calls)").all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).to.include.members(["outcome", "knowledge_id", "session_id", "requested_model"]);
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'finished_sessions'").get()).to.not.equal(undefined);
    legacy.close();
  });

  it("prunes rows older than 90 days when attached (startup)", () => {
    recordCall({ task: "kg", latencyMs: 1, ok: true, ts: new Date("2026-07-01T00:00:00Z") }); // 101 days old
    recordCall({ task: "kg", latencyMs: 1, ok: true, ts: new Date("2026-08-01T00:00:00Z") }); // 70 days old
    recordSessionFinished("old", "k", new Date("2026-06-01T00:00:00Z"));
    attachUsageStore(db, NOW);
    expect((db.prepare("SELECT COUNT(*) AS n FROM llm_calls").get() as { n: number }).n).to.equal(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM finished_sessions").get() as { n: number }).n).to.equal(0);
  });

  it("chatCompletion records the model that answered, tokens, usage.cost, latency and the context ids", async () => {
    stubChat(() => ({ ok: true }), "google/gemini-2.5-flash"); // e.g. a fallback answered
    await runWithUsageContext({ knowledgeId: "book-1" }, () =>
      chatCompletion("kg", { model: "anthropic/claude-haiku-5.5", fallbacks: ["google/gemini-2.5-flash"] }, { messages: [] }));
    const row = db.prepare("SELECT * FROM llm_calls").get() as any;
    expect(row).to.include({
      task: "kg", model: "google/gemini-2.5-flash", requested_model: "anthropic/claude-haiku-5.5",
      input_tokens: 100, output_tokens: 20, cost_usd: 0.0001, ok: 1, knowledge_id: "book-1", session_id: null,
    });
  });

  it("records failed calls (ok = 0, error) and still throws", async () => {
    stubChat(() => { throw new Error("boom"); });
    try {
      await chatCompletion("title", { model: "openai/gpt-5-nano", fallbacks: [] }, { messages: [] }, { resilient: false });
      expect.fail("should throw");
    } catch (err) {
      expect((err as Error).message).to.equal("boom");
    }
    const row = db.prepare("SELECT task, ok, error, model FROM llm_calls").get();
    expect(row).to.deep.equal({ task: "title", ok: 0, error: "boom", model: "openai/gpt-5-nano" });
  });

  it("aggregates totals, byDay (zero-filled), byTask, perBook, perSession and System One outcomes", () => {
    // Indexing book A (2 kg calls + title) and book B (1 kg call)
    recordCall({ task: "kg", model: "anthropic/claude-haiku-5.5", costUsd: 0.002, latencyMs: 1000, ok: true, knowledgeId: "A", ts: day("2026-10-08") });
    recordCall({ task: "kg", model: "anthropic/claude-haiku-5.5", costUsd: 0.003, latencyMs: 3000, ok: true, knowledgeId: "A", ts: day("2026-10-08") });
    recordCall({ task: "title", model: "openai/gpt-5-nano", costUsd: 0.00001, latencyMs: 500, ok: true, knowledgeId: "A", ts: day("2026-10-08") });
    recordCall({ task: "kg", model: "anthropic/claude-haiku-5.5", costUsd: 0.001, latencyMs: 2000, ok: false, error: "x", knowledgeId: "B", ts: day("2026-10-09") });
    // Session s1 (finished): generation + check + grade + escalation
    recordCall({ task: "question", model: "anthropic/claude-haiku-5.5", costUsd: 0.0004, latencyMs: 900, ok: true, knowledgeId: "A", sessionId: "s1", ts: day("2026-10-10") });
    const chk = recordCall({ task: "question_check", model: "typesafe/jev-1.13-20260917", costUsd: 0.00002, latencyMs: 300, ok: true, sessionId: "s1", ts: day("2026-10-10") });
    setCallOutcome(chk, "regenerate:not_plain+key_mismatch");
    const g1 = recordCall({ task: "grade", model: "typesafe/jev-1.13-20260917", costUsd: 0.00002, latencyMs: 350, ok: true, sessionId: "s1", ts: day("2026-10-10") });
    setCallOutcome(g1, "escalated:low_confidence");
    recordCall({ task: "grade_escalation", model: "openai/gpt-6-luna", costUsd: 0.0002, latencyMs: 2500, ok: true, outcome: "escalated:low_confidence", sessionId: "s1", ts: day("2026-10-10") });
    const g2 = recordCall({ task: "grade", model: "typesafe/jev-1.13-20260917", costUsd: 0.00002, latencyMs: 250, ok: true, sessionId: "s2", ts: day("2026-10-10") });
    setCallOutcome(g2, "accepted");
    const c2 = recordCall({ task: "question_check", model: "typesafe/jev-1.13-20260917", costUsd: 0.00002, latencyMs: 300, ok: true, sessionId: "s2", ts: day("2026-10-10") });
    setCallOutcome(c2, "pass");
    recordSessionFinished("s1", "A", day("2026-10-10", "11:00:00"));
    // Outside a 3-day window
    recordCall({ task: "kg", model: "anthropic/claude-haiku-5.5", costUsd: 1, latencyMs: 1, ok: true, knowledgeId: "OLD", ts: day("2026-10-01") });

    const s = getUsageSummary(3, NOW);
    expect(s.totals).to.deep.equal({ calls: 10, costUsd: 0.00669, errors: 1 });
    expect(s.byDay).to.deep.equal([
      { date: "2026-10-08", calls: 3, costUsd: 0.00501 },
      { date: "2026-10-09", calls: 1, costUsd: 0.001 },
      { date: "2026-10-10", calls: 6, costUsd: 0.00068 },
    ]);
    const kg = s.byTask.find(t => t.task === "kg")!;
    expect(kg).to.deep.equal({ task: "kg", model: "anthropic/claude-haiku-5.5", calls: 3, costUsd: 0.006, avgLatencyMs: 2000, errors: 1 });
    expect(s.byTask[0].task).to.equal("kg"); // most expensive first
    expect(s.byTask.find(t => t.task === "grade")).to.include({ model: "typesafe/jev-1.13-20260917", calls: 2 });
    expect(s.perBook).to.deep.equal({ avgCostUsd: 0.003005, count: 2 }); // A 0.00501, B 0.001
    expect(s.perSession).to.deep.equal({ avgCostUsd: 0.00064, count: 1 }); // s1 only (s2 unfinished)
    expect(s.quality).to.deep.equal({
      questionCheck: { checked: 2, passed: 1, regenerated: 1, reasons: { not_plain: 1, key_mismatch: 1 } },
      grading: { jev: 1, escalated: 1, reasons: { low_confidence: 1 } },
    });
  });

  it("an empty log gives zeros, null averages and one byDay entry per day", () => {
    const s = getUsageSummary(30, NOW);
    expect(s.totals).to.deep.equal({ calls: 0, costUsd: 0, errors: 0 });
    expect(s.byDay).to.have.length(30);
    expect(s.byDay[29]).to.deep.equal({ date: "2026-10-10", calls: 0, costUsd: 0 });
    expect(s.byDay[0].date).to.equal("2026-09-11");
    expect(s.perBook).to.deep.equal({ avgCostUsd: null, count: 0 });
    expect(s.perSession).to.deep.equal({ avgCostUsd: null, count: 0 });
  });

  it("recording is a no-op without an attached database", () => {
    attachUsageStore(null);
    expect(recordCall({ task: "kg", latencyMs: 1, ok: true })).to.equal(null);
    expect(__usageDbForTest()).to.equal(null);
    expect(getUsageSummary(7, NOW).totals.calls).to.equal(0);
  });

  it("maps the OpenRouter auth/key response to { limitUsd, usageUsd, remainingUsd }", () => {
    expect(parseKeyStatus({ data: { limit: 6, usage: 1.32, limit_remaining: 4.68 } })).to.deep.equal({ limitUsd: 6, usageUsd: 1.32, remainingUsd: 4.68 });
    expect(parseKeyStatus({ data: { limit: null, usage: 2, limit_remaining: null } })).to.deep.equal({ limitUsd: null, usageUsd: 2, remainingUsd: null });
    expect(parseKeyStatus({ data: { limit: 5, usage: 2 } })).to.deep.equal({ limitUsd: 5, usageUsd: 2, remainingUsd: 3 });
    expect(parseKeyStatus({ error: "nope" })).to.equal(null);
  });
});
