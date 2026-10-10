import { expect } from "chai";
import Database from "better-sqlite3";

import { __setGetConceptsByDifficultyForTest, __setGetImportantConceptsForTest } from "../src/services/kg-store";
import { VerifySession } from "../src/sdk/verify-session";
import { resolveConfig } from "../src/sdk/types";
import { attachUsageStore, getUsageSummary } from "../src/services/usage-store";
import { stubChat, restoreChat, stubDecisions, restoreDecisions, decisionsBody } from "./helpers/model-stubs";

/**
 * End-to-end session flow with the new pipeline: generation (modelAnswer + keyPoints) →
 * question check → Jev grading → answer feedback, and the per-session cost log.
 */
describe("VerifySession — open-answer feedback and per-session usage", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    attachUsageStore(db);
    __setGetConceptsByDifficultyForTest(async () => ({
      concepts: [{ id: "tea_party", label: "Mad Tea-Party", bloomLevel: "Analyze", importance: 8 }],
      subgraph: { nodes: [], edges: [] },
    }));
    __setGetImportantConceptsForTest(async () => []);
  });
  afterEach(() => {
    restoreChat();
    restoreDecisions();
    attachUsageStore(null);
    db.close();
    __setGetConceptsByDifficultyForTest(null);
    __setGetImportantConceptsForTest(null);
  });

  const KP = ["The Hatter quarrelled with Time", "Time stopped at six o'clock"];

  it("returns keyPoints, modelAnswer, gradedBy and a key-point sentence; logs calls against the session", async () => {
    const chat = stubChat(() => ({
      question: "Why is it always six o'clock at the Mad Tea-Party?",
      modelAnswer: "The Hatter quarrelled with Time, so Time stopped the clocks at six. It is always tea-time now.",
      keyPoints: KP,
      targetConcept: "tea_party",
      bloomLevel: "Evaluate", // capped to Analyze
      difficulty: 1,
    }), "anthropic/claude-haiku-5.5");
    const dec = stubDecisions(body =>
      "verdict" in body.questions
        ? decisionsBody({ kp_1: ["covered", 0.9], kp_2: ["partial", 0.8], verdict: ["correct", 0.9] })
        : decisionsBody({ answerable_from_passage: ["yes", 0.9], plainly_worded: ["yes", 0.95] }));

    const session = new VerifySession(1, "book-1", ["The Hatter said Time won't do a thing he asks; it's always six o'clock now."], "u", resolveConfig({ max_questions: 1, q_types: ["open"] }));
    await session.init();
    expect(session.currentQuestion.bloomLevel).to.equal("Analyze");
    expect(chat[0].body.reasoning).to.deep.equal({ enabled: false });

    const fb = await session.submitAnswer("He fought with Time and the clock got stuck around six.");
    expect(fb).to.deep.include({
      correct: true,
      score: 75,
      gradedBy: "jev",
      reasoning: "You covered 1 of 2 key points, and 1 more partly.",
      modelAnswer: "The Hatter quarrelled with Time, so Time stopped the clocks at six. It is always tea-time now.",
      isComplete: true,
    });
    expect(fb.keyPoints).to.deep.equal([
      { point: KP[0], status: "covered" },
      { point: KP[1], status: "partial" },
    ]);
    expect(fb.referenceKeyPoints).to.deep.equal(KP);
    expect(dec).to.have.length(2); // question check + grade

    const rows = db.prepare("SELECT task, session_id, knowledge_id FROM llm_calls ORDER BY id").all();
    expect(rows).to.deep.equal([
      { task: "question", session_id: session.sessionId, knowledge_id: "book-1" },
      { task: "question_check", session_id: session.sessionId, knowledge_id: "book-1" },
      { task: "grade", session_id: session.sessionId, knowledge_id: "book-1" },
    ]);
    const summary = getUsageSummary(1);
    expect(summary.perSession.count).to.equal(1);
    expect(summary.perSession.avgCostUsd).to.be.closeTo(0.0001 + 0.00002 + 0.00002, 1e-9);
    expect(summary.perBook.count).to.equal(0); // session calls are not indexing calls
  });

  it("MCQ / true-false feedback stays deterministic (no grader call, no key-point fields)", async () => {
    stubChat(() => ({ statement: "Alice shrinks after drinking from the bottle.", correctAnswer: true, targetConcept: "tea_party", bloomLevel: "Remember", difficulty: -1 }));
    const dec = stubDecisions(() => decisionsBody({ answerable_from_passage: ["yes", 0.9], plainly_worded: ["yes", 0.9] }));
    const session = new VerifySession(1, "book-1", ["Alice drank and shrank."], "u", resolveConfig({ max_questions: 1, q_types: ["true_false"] }));
    await session.init();
    const fb = await session.submitAnswer("true");
    expect(fb).to.deep.include({ correct: true, score: 100, correctAnswer: "true" });
    expect(fb.keyPoints).to.equal(undefined); // dropped from the JSON response
    expect(fb.modelAnswer).to.equal(undefined);
    expect(fb.gradedBy).to.equal(undefined);
    expect(dec).to.have.length(1); // only the question check
  });
});
