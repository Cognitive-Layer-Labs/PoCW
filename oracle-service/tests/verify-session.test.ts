import { expect } from "chai";
import sinon from "sinon";

import { __setGetConceptsByDifficultyForTest } from "../src/services/kg-store";
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
  });

  afterEach(() => {
    __setGetConceptsByDifficultyForTest(null);
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

    const config = resolveConfig({ max_questions: 3, q_types: ["open"], attest: "none" });
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

    const config = resolveConfig({ max_questions: 1, q_types: ["open"], attest: "none" });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    await session.submitAnswer("Correct answer");
    const result = await session.getResult();

    expect(result.passed).to.be.a("boolean");
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

    const config = resolveConfig({ max_questions: 1, q_types: ["open"], response: "detailed", attest: "none" });
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

    const config = resolveConfig({ max_questions: 1, q_types: ["open"], response: "score", attest: "none" });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    await session.submitAnswer("Answer");
    const result = await session.getResult();

    expect(result.response_detail).to.be.undefined;
  });

  it("handles MCQ questions with instant grading (no LLM grade call)", async () => {
    stubLLMSequence([mcqQuestion]); // Only Q1 generation, no grade LLM call needed

    const config = resolveConfig({ max_questions: 1, q_types: ["mcq"], attest: "none" });
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
    const config = resolveConfig({ max_questions: 1, q_types: ["open"], attest: "none" });
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

    const config = resolveConfig({ max_questions: 1, q_types: ["open"], threshold: 0.9, attest: "none" });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();

    await session.submitAnswer("Bad answer");
    const result = await session.getResult();

    // With a wrong answer, score should be low, so passed should be false with threshold=0.9
    expect(result.passed).to.be.false;
  });
});
