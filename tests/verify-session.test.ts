import { expect } from "chai";
import sinon from "sinon";

import {
  __setGetConceptsByDifficultyForTest,
  __setGetImportantConceptsForTest,
} from "../src/services/kg-store";
import * as llmClient from "../src/services/llm-client";
import { VerifySession } from "../src/sdk/verify-session";
import { resolveConfig, PoCWError } from "../src/sdk/types";

const mockConcepts = async () => ({
  concepts: [
    { id: "c1", label: "Concept A", bloomLevel: "Understand", importance: 8 },
  ],
  subgraph: {
    nodes: [{ id: "c1", label: "Concept A", bloomLevel: "Understand", importance: 8 }],
    edges: [],
  },
});

function stubLLMSequence(responses: object[]) {
  let callIndex = 0;
  llmClient.__setOpenAIClientProviderForTest(() => ({
    chat: {
      completions: {
        create: sinon.stub().callsFake(async () => {
          const resp = responses[Math.min(callIndex, responses.length - 1)];
          callIndex++;
          return { choices: [{ message: { content: JSON.stringify(resp) } }] };
        }),
      },
    },
  } as any));
}

// Mock open question + grade responses
const openQuestion = {
  question: "What is concept A?",
  targetConcept: "c1",
  bloomLevel: "Understand",
  difficulty: 0,
};

const correctGrade = {
  accuracy: 22, depth: 20, specificity: 20, reasoning_score: 18,
  score: 80, correct: true, reasoning: "Good answer",
};

const wrongGrade = {
  accuracy: 5, depth: 3, specificity: 2, reasoning_score: 5,
  score: 15, correct: false, reasoning: "Incorrect",
};

const mcqQuestion = {
  question: "Which option?",
  options: ["Opt A", "Opt B", "Opt C", "Opt D"],
  correctAnswer: "B",
  targetConcept: "c1",
  bloomLevel: "Understand",
  difficulty: 0,
};

describe("VerifySession", () => {
  const chunks = ["Chunk one content", "Chunk two content", "Chunk three content"];

  beforeEach(() => {
    __setGetConceptsByDifficultyForTest(mockConcepts);
    __setGetImportantConceptsForTest(async () => []);
  });

  afterEach(() => {
    __setGetConceptsByDifficultyForTest(null);
    __setGetImportantConceptsForTest(null);
    sinon.restore();
  });

  it("initializes and provides first question", async () => {
    stubLLMSequence([openQuestion]);
    const config = resolveConfig({ max_questions: 3, q_types: ["open"] });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    expect(session.isActive()).to.be.true;
    const q = session.currentQuestion;
    expect(q.number).to.equal(1);
    expect(q.totalQuestions).to.equal(3);
    expect(q.text).to.equal("What is concept A?");
  });

  it("completes after max_questions answers (open)", async () => {
    // 3 questions: Q1 (from init), grade1, Q2 (next), grade2, Q3 (next)
    // LLM calls: Q1, grade1, Q2, grade2, Q3, grade3
    stubLLMSequence([
      openQuestion,  // Q1
      correctGrade,  // grade Q1
      openQuestion,  // Q2
      wrongGrade,    // grade Q2
      openQuestion,  // Q3 (last)
    ]);

    const config = resolveConfig({ max_questions: 3, q_types: ["open"] });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    // Answer Q1
    const fb1 = await session.submitAnswer("My answer 1");
    expect(fb1.correct).to.be.true;
    expect(fb1.isComplete).to.be.false;
    expect(fb1.progress.questionNumber).to.equal(1);

    // Answer Q2
    const fb2 = await session.submitAnswer("My answer 2");
    expect(fb2.correct).to.be.false;
    expect(fb2.isComplete).to.be.false;

    // Answer Q3 — should complete
    // Need to stub grade for Q3
    stubLLMSequence([correctGrade]);
    const fb3 = await session.submitAnswer("My answer 3");
    expect(fb3.isComplete).to.be.true;
    expect(session.isActive()).to.be.false;
  });

  it("returns result with score after completion", async () => {
    stubLLMSequence([openQuestion, correctGrade]);

    const config = resolveConfig({ max_questions: 1, q_types: ["open"] });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    await session.submitAnswer("Correct answer");
    const result = await session.getResult();

    expect(result.competenceIndicator).to.be.a("boolean");
    expect(result.score).to.be.a("number");
    expect(result.score).to.be.within(0, 100);
    expect(result.theta).to.be.a("number");
    expect(result.se).to.be.a("number");
    expect(result.questions_asked).to.equal(1);
    expect(result.knowledgeId).to.equal("kid1");
    expect(result.subject).to.equal("user1");
    expect(result.confidence_interval).to.be.an("array").with.length(2);
    expect(result.timestamp).to.be.a("string");
  });

  it("includes response_detail when config.response='detailed'", async () => {
    stubLLMSequence([openQuestion, correctGrade]);

    const config = resolveConfig({ max_questions: 1, q_types: ["open"], response: "detailed" });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    await session.submitAnswer("Answer");
    const result = await session.getResult();

    expect(result.response_detail).to.be.an("array");
    expect(result.response_detail!.length).to.equal(1);
    expect(result.response_detail![0].question).to.equal("What is concept A?");
    expect(result.response_detail![0].type).to.equal("open");
  });

  it("omits response_detail when config.response='score'", async () => {
    stubLLMSequence([openQuestion, correctGrade]);

    const config = resolveConfig({ max_questions: 1, q_types: ["open"], response: "score" });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    await session.submitAnswer("Answer");
    const result = await session.getResult();

    expect(result.response_detail).to.be.undefined;
  });

  it("handles MCQ questions with instant grading (no LLM grade call)", async () => {
    stubLLMSequence([mcqQuestion]); // Only Q1 generation, no grade LLM call needed

    const config = resolveConfig({ max_questions: 1, q_types: ["mcq"] });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    const q = session.currentQuestion;
    expect(q.type).to.equal("mcq");
    expect(q.options).to.have.length(4);

    const fb = await session.submitAnswer("B");
    expect(fb.correct).to.be.true;
    expect(fb.score).to.equal(100);
    expect(fb.isComplete).to.be.true;
  });

  it("throws SESSION_NOT_ACTIVE when calling getResult before completion", async () => {
    stubLLMSequence([openQuestion]);
    const config = resolveConfig({ max_questions: 3, q_types: ["open"] });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    try {
      await session.getResult();
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).to.be.instanceOf(PoCWError);
      expect((err as PoCWError).code).to.equal("SESSION_NOT_ACTIVE");
    }
  });

  it("throws SESSION_NOT_ACTIVE when submitting answer after completion", async () => {
    stubLLMSequence([openQuestion, correctGrade]);
    const config = resolveConfig({ max_questions: 1, q_types: ["open"] });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    await session.submitAnswer("Answer");

    try {
      await session.submitAnswer("Another");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).to.be.instanceOf(PoCWError);
      expect((err as PoCWError).code).to.equal("SESSION_NOT_ACTIVE");
    }
  });

  it("uses config.threshold for pass/fail", async () => {
    // Low score answer
    stubLLMSequence([openQuestion, wrongGrade]);

    const config = resolveConfig({ max_questions: 1, q_types: ["open"], threshold: 0.9 });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    await session.submitAnswer("Bad answer");
    const result = await session.getResult();

    // With a wrong answer, score should be low, so the indicator is false with threshold=0.9
    expect(result.competenceIndicator).to.be.false;
  });

  it("result has no web3 fields and always includes concepts + profile", async () => {
    stubLLMSequence([openQuestion, correctGrade]);
    const config = resolveConfig({ max_questions: 1, q_types: ["open"] });
    const session = new VerifySession(1, "kid1", chunks, "anonymous", config);
    await session.init();
    await session.submitAnswer("Answer");
    const result = await session.getResult() as unknown as Record<string, unknown>;

    for (const k of ["attestation", "tokenUri", "kalAmount"]) {
      expect(result).to.not.have.property(k);
    }
    expect(result.concepts).to.be.an("array");
    expect(result.disclaimers).to.be.an("object");
    const profile = result.profile as Record<string, unknown>;
    expect(profile.questionTypes).to.deep.equal(["open"]);
    expect(profile.bloomCoverage).to.deep.equal({ Understand: 1 });
  });

  it("returns a frozen, identical result on repeated getResult() and after snapshot round-trip", async () => {
    stubLLMSequence([openQuestion, correctGrade]);
    const config = resolveConfig({ max_questions: 1, q_types: ["open"] });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();
    await session.submitAnswer("Answer");
    const r1 = await session.getResult();
    const r2 = await session.getResult();
    expect(r2).to.deep.equal(r1);

    const restored = VerifySession.fromSnapshot(JSON.parse(JSON.stringify(session.toSnapshot())));
    expect(restored.isComplete()).to.be.true;
    expect(await restored.getResult()).to.deep.equal(JSON.parse(JSON.stringify(r1)));
  });

  describe("per-concept outcomes", () => {
    /** Route stubbed LLM calls by purpose: generation, quality-eval (always pass), grading. */
    function stubLLMByRole(questions: object[], grades: object[]) {
      let qi = 0;
      let gi = 0;
      llmClient.__setOpenAIClientProviderForTest(() => ({
        chat: {
          completions: {
            create: sinon.stub().callsFake(async (req: { messages: Array<{ content: string }> }) => {
              const user = req.messages[req.messages.length - 1]?.content ?? "";
              let resp: object;
              if (user.startsWith("TARGET_BLOOM:")) resp = { pass: true, feedback: "", bloomMatch: true };
              else if (user.startsWith("QUESTION:")) resp = grades[Math.min(gi++, grades.length - 1)];
              else resp = questions[Math.min(qi++, questions.length - 1)];
              return { choices: [{ message: { content: JSON.stringify(resp) } }] };
            }),
          },
        },
      } as any));
    }

    const important = [
      { id: "c1", label: "Concept A", bloomLevel: "Understand", importance: 0.9 },
      { id: "c2", label: "Concept B", bloomLevel: "Apply", importance: 0.8 },
      { id: "c3", label: "Concept C", bloomLevel: "Analyze", importance: 0.7 },
    ];

    beforeEach(() => {
      __setGetImportantConceptsForTest(async () => important);
    });

    it("tracks asked/correct/mastered per KG concept and tags response_detail with conceptId", async () => {
      // Targets follow the mastery loop: c1 (correct → mastered), c2 (wrong → failed), then
      // re-ask c2 (failed concepts first, by importance).
      const claimsAll = { covered_points: 4, total_points: 4, precision_cap: 100, correct: true, reasoning: "ok" };
      const claimsNone = { covered_points: 0, total_points: 4, precision_cap: 100, correct: false, reasoning: "no" };
      stubLLMByRole(
        [
          { ...openQuestion, question: "Q about A" },
          { ...openQuestion, question: "Q about B" },
          { ...openQuestion, question: "Q about B again" },
        ],
        [claimsAll, claimsNone, claimsAll],
      );
      const config = resolveConfig({ max_questions: 3, q_types: ["open"], response: "detailed" });
      const session = new VerifySession(1, "kid1", chunks, "user1", config);
      await session.init();
      expect(session.importantConceptCount).to.equal(3);

      await session.submitAnswer("a1");
      await session.submitAnswer("a2");
      await session.submitAnswer("a3");
      const result = await session.getResult();

      expect(result.concepts.map(c => c.id)).to.deep.equal(["c1", "c2", "c3"]);
      const byId = Object.fromEntries(result.concepts.map(c => [c.id, c]));
      expect(byId.c1).to.deep.equal({ id: "c1", label: "Concept A", asked: 1, correct: 1, mastered: true });
      expect(byId.c2).to.deep.equal({ id: "c2", label: "Concept B", asked: 2, correct: 1, mastered: true });
      expect(byId.c3).to.deep.equal({ id: "c3", label: "Concept C", asked: 0, correct: 0, mastered: false });

      expect(result.response_detail!.map(r => r.conceptId)).to.deep.equal(["c1", "c2", "c2"]);
    });

    it("maps untargeted questions to a concept by label, else null", async () => {
      // No important concepts → Fisher mode (no explicit target); the LLM-reported
      // targetConcept is matched by label when possible.
      __setGetImportantConceptsForTest(async () => []);
      stubLLMByRole(
        [{ ...openQuestion, targetConcept: "Something else" }],
        [{ covered_points: 4, total_points: 4, precision_cap: 100, correct: true, reasoning: "ok" }],
      );
      const config = resolveConfig({ max_questions: 1, q_types: ["open"], response: "detailed" });
      const session = new VerifySession(1, "kid1", chunks, "user1", config);
      await session.init();
      await session.submitAnswer("a1");
      const result = await session.getResult();
      expect(result.concepts).to.deep.equal([]);
      expect(result.response_detail![0].conceptId).to.equal(null);
    });
  });
});
