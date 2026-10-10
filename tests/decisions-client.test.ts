import { expect } from "chai";
import Database from "better-sqlite3";

import {
  decide,
  DecisionsError,
  DECISIONS_URL,
  parseDecisionsResponse,
  DecisionQuestion,
  __setDecisionsFetchForTest,
} from "../src/services/decisions-client";
import { attachUsageStore, __usageDbForTest } from "../src/services/usage-store";
import { runWithUsageContext } from "../src/services/usage-context";
import { stubDecisions, restoreDecisions, decisionsBody, jsonResponse } from "./helpers/model-stubs";

const questions: Record<string, DecisionQuestion> = {
  verdict: { type: "choice", instructions: "Is it right?", criteria: { correct: "yes", partial: "kind of", wrong: "no" } },
};

describe("Decisions client (Jev)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    attachUsageStore(db);
  });
  afterEach(() => {
    restoreDecisions();
    attachUsageStore(null);
    db.close();
  });

  const rows = () => __usageDbForTest()!.prepare("SELECT * FROM llm_calls ORDER BY id").all() as any[];

  it("POSTs { model, state, questions } with the bearer key and parses the answers", async () => {
    const calls = stubDecisions(() => decisionsBody({ verdict: ["correct", 0.97] }));
    const res = await decide({ model: "typesafe/jev-1.13", state: { q: "x" }, questions }, { task: "grade" });

    expect(calls).to.have.length(1);
    expect(calls[0].url).to.equal(DECISIONS_URL);
    expect(calls[0].url).to.equal("https://openrouter.ai/api/alpha/decisions");
    expect(calls[0].headers.Authorization).to.equal("Bearer test-key");
    expect(calls[0].body).to.deep.equal({ model: "typesafe/jev-1.13", state: { q: "x" }, questions });

    expect(res.model).to.equal("typesafe/jev-1.13-20260917");
    expect(res.answers.verdict).to.deep.include({ type: "choice", choice: "correct", confidence: 0.97 });
    expect(res.usage).to.deep.equal({ inputTokens: 500, outputTokens: 70, costUsd: 0.00002 });
    expect(res.callId).to.be.a("number");
  });

  it("logs the call (actual model, tokens, cost, latency, context ids)", async () => {
    stubDecisions(() => decisionsBody({ verdict: ["wrong", 1] }, 0.000024));
    await runWithUsageContext({ sessionId: "s1", knowledgeId: "k1" }, () =>
      decide({ model: "typesafe/jev-1.13", state: "ctx", questions }, { task: "question_check" }));
    const [r] = rows();
    expect(r).to.include({
      task: "question_check", model: "typesafe/jev-1.13-20260917", requested_model: "typesafe/jev-1.13",
      input_tokens: 500, output_tokens: 70, cost_usd: 0.000024, ok: 1, session_id: "s1", knowledge_id: "k1",
    });
    expect(r.latency_ms).to.be.a("number");
  });

  it("parses score answers (ordinal scale)", () => {
    const q: Record<string, DecisionQuestion> = { s: { type: "score", instructions: "rate", criteria: ["bad", "ok", "good"] } };
    const parsed = parseDecisionsResponse({
      model: "m", answers: { s: { type: "score", score: 1.7, legend: { 0: "bad", 1: "ok", 2: "good" }, probabilities: { 1: 0.3, 2: 0.7 }, confidence: 0.55 } },
    }, q);
    expect(parsed.answers.s).to.deep.equal({ type: "score", score: 1.7, legend: { 0: "bad", 1: "ok", 2: "good" }, probabilities: { 1: 0.3, 2: 0.7 }, confidence: 0.55 });
  });

  it("rejects responses with a missing answer or a choice outside the criteria", () => {
    expect(() => parseDecisionsResponse({ answers: {} }, questions)).to.throw(DecisionsError, /missing answer "verdict"/);
    expect(() => parseDecisionsResponse({ answers: { verdict: { type: "choice", choice: "maybe" } } }, questions))
      .to.throw(DecisionsError, /unknown choice/);
    expect(() => parseDecisionsResponse("nope", questions)).to.throw(DecisionsError);
  });

  it("derives confidence from the probabilities when it is missing", () => {
    const parsed = parseDecisionsResponse({ answers: { verdict: { choice: "partial", probabilities: { partial: 0.8, wrong: 0.2 } } } }, questions);
    expect((parsed.answers.verdict as any).confidence).to.equal(0.8);
  });

  it("retries once on 5xx / 429 and then succeeds", async () => {
    const calls = stubDecisions((_b, n) => (n === 1 ? jsonResponse({ error: "busy" }, 503) : decisionsBody({ verdict: ["correct", 0.9] })));
    const res = await decide({ model: "typesafe/jev-1.13", state: "s", questions }, { task: "grade" });
    expect(calls).to.have.length(2);
    expect(res.answers.verdict).to.deep.include({ choice: "correct" });
    expect(rows().map(r => r.ok)).to.deep.equal([0, 1]);
  });

  it("does not retry a 400 (bad request) and throws DecisionsError", async () => {
    const calls = stubDecisions(() => jsonResponse({ error: { message: "bad" } }, 400));
    try {
      await decide({ model: "typesafe/jev-1.13", state: "s", questions }, { task: "grade" });
      expect.fail("should throw");
    } catch (err) {
      expect(err).to.be.instanceOf(DecisionsError);
      expect((err as DecisionsError).status).to.equal(400);
    }
    expect(calls).to.have.length(1);
  });

  it("times out (one retry) and throws DecisionsError", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    let attempts = 0;
    __setDecisionsFetchForTest((_url, init) => {
      attempts++;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      });
    });
    const t0 = Date.now();
    try {
      await decide({ model: "typesafe/jev-1.13", state: "s", questions }, { task: "grade", timeoutMs: 50 });
      expect.fail("should throw");
    } catch (err) {
      expect(err).to.be.instanceOf(DecisionsError);
      expect((err as Error).message).to.match(/timed out/);
    }
    expect(attempts).to.equal(2);
    expect(Date.now() - t0).to.be.below(2000);
    expect(rows().map(r => [r.ok, r.error])).to.deep.equal([[0, "decisions API timed out"], [0, "decisions API timed out"]]);
  });

  it("fails fast without a key, and after three failed calls in a row (cool-down)", async () => {
    delete process.env.OPENROUTER_API_KEY;
    try {
      await decide({ model: "m", state: "s", questions }, { task: "grade" });
      expect.fail("should throw");
    } catch (err) {
      expect((err as Error).message).to.match(/OPENROUTER_API_KEY/);
    }

    const calls = stubDecisions(() => jsonResponse({}, 400));
    for (let i = 0; i < 3; i++) {
      await decide({ model: "m", state: "s", questions }, { task: "grade" }).catch(() => undefined);
    }
    expect(calls).to.have.length(3);
    try {
      await decide({ model: "m", state: "s", questions }, { task: "grade" });
      expect.fail("should throw");
    } catch (err) {
      expect((err as Error).message).to.match(/cooling down/);
    }
    expect(calls).to.have.length(3); // no HTTP call while cooling down
  });
});
