import { expect } from "chai";
import sinon from "sinon";

import { __setGetConceptsByDifficultyForTest } from "../src/services/kg-store";
import * as llmClient from "../src/services/llm-client";
import {
  generateQuestion,
  generateMCQ,
  generateTrueFalse,
  generateScenario,
  gradeMCQOrTF,
  QuestionGenerationError,
} from "../src/services/question-generator";

const mockConcepts = async () => ({
  concepts: [
    { id: "c1", label: "Concept A", bloomLevel: "Understand", importance: 8 },
  ],
  subgraph: {
    nodes: [{ id: "c1", label: "Concept A", bloomLevel: "Understand", importance: 8 }],
    edges: [],
  },
});

function stubLLM(response: object) {
  llmClient.__setOpenAIClientProviderForTest(() => ({
    chat: {
      completions: {
        create: sinon.stub().resolves({
          choices: [{ message: { content: JSON.stringify(response) } }],
        }),
      },
    },
  } as any));
}

describe("Question Types", () => {
  beforeEach(() => {
    __setGetConceptsByDifficultyForTest(mockConcepts);
  });

  afterEach(() => {
    __setGetConceptsByDifficultyForTest(null);
    sinon.restore();
  });

  describe("generateQuestion() dispatcher", () => {
    it("dispatches 'open' to generateSingleQuestion", async () => {
      stubLLM({
        question: "What is X?",
        targetConcept: "c1",
        bloomLevel: "Understand",
        difficulty: 0,
      });
      const q = await generateQuestion(1, "content", 0, [], "open");
      expect(q.type).to.equal("open");
      expect(q.question).to.equal("What is X?");
    });

    it("dispatches 'mcq' to generateMCQ", async () => {
      stubLLM({
        question: "Which option?",
        options: ["Opt A", "Opt B", "Opt C", "Opt D"],
        correctAnswer: "B",
        targetConcept: "c1",
        bloomLevel: "Understand",
        difficulty: 0,
      });
      const q = await generateQuestion(1, "content", 0, [], "mcq");
      expect(q.type).to.equal("mcq");
      expect(q.options).to.have.length(4);
      expect(q.correctAnswer).to.equal("B");
    });

    it("dispatches 'true_false' to generateTrueFalse", async () => {
      stubLLM({
        statement: "The sky is blue.",
        correctAnswer: true,
        targetConcept: "c1",
        bloomLevel: "Remember",
        difficulty: -1,
      });
      const q = await generateQuestion(1, "content", -1, [], "true_false");
      expect(q.type).to.equal("true_false");
      expect(q.question).to.equal("The sky is blue.");
      expect(q.correctAnswer).to.equal("true");
    });

    it("dispatches 'scenario' to generateScenario", async () => {
      stubLLM({
        question: "Given scenario X, what would you do?",
        targetConcept: "c1",
        bloomLevel: "Analyze",
        difficulty: 1,
      });
      const q = await generateQuestion(1, "content", 1, [], "scenario");
      expect(q.type).to.equal("scenario");
    });
  });

  describe("MCQ generation", () => {
    it("generates valid MCQ with 4 options", async () => {
      stubLLM({
        question: "What is the capital?",
        options: ["London", "Paris", "Berlin", "Madrid"],
        correctAnswer: "B",
        targetConcept: "capital",
        bloomLevel: "Remember",
        difficulty: -1.5,
      });

      const q = await generateMCQ(1, "Geography content", -1.5, []);
      expect(q.type).to.equal("mcq");
      expect(q.options).to.deep.equal(["London", "Paris", "Berlin", "Madrid"]);
      expect(q.correctAnswer).to.equal("B");
    });

    it("throws on invalid MCQ (less than 4 options)", async () => {
      stubLLM({
        question: "Bad MCQ",
        options: ["A", "B"],
        correctAnswer: "A",
        targetConcept: "c1",
      });

      try {
        await generateMCQ(1, "content", 0, []);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.instanceOf(QuestionGenerationError);
      }
    });
  });

  describe("True/False generation", () => {
    it("generates valid true/false statement", async () => {
      stubLLM({
        statement: "Water boils at 100°C at sea level.",
        correctAnswer: true,
        targetConcept: "boiling_point",
        bloomLevel: "Remember",
        difficulty: -2,
      });

      const q = await generateTrueFalse(1, "Science content", -2, []);
      expect(q.type).to.equal("true_false");
      expect(q.question).to.equal("Water boils at 100°C at sea level.");
      expect(q.correctAnswer).to.equal("true");
    });

    it("handles string correctAnswer", async () => {
      stubLLM({
        statement: "False statement",
        correctAnswer: "false",
        targetConcept: "c1",
        bloomLevel: "Understand",
        difficulty: 0,
      });

      const q = await generateTrueFalse(1, "content", 0, []);
      expect(q.correctAnswer).to.equal("false");
    });
  });

  describe("Scenario generation", () => {
    it("generates scenario with type='scenario'", async () => {
      stubLLM({
        question: "Imagine you are debugging a production issue...",
        targetConcept: "debugging",
        bloomLevel: "Analyze",
        difficulty: 1.5,
      });

      const q = await generateScenario(1, "Dev content", 1.5, []);
      expect(q.type).to.equal("scenario");
      expect(q.question).to.contain("debugging");
    });
  });

  describe("gradeMCQOrTF()", () => {
    it("grades correct MCQ answer", () => {
      const result = gradeMCQOrTF("B", "B", "mcq");
      expect(result.correct).to.be.true;
      expect(result.score).to.equal(100);
    });

    it("grades incorrect MCQ answer", () => {
      const result = gradeMCQOrTF("A", "C", "mcq");
      expect(result.correct).to.be.false;
      expect(result.score).to.equal(0);
    });

    it("accepts case-insensitive MCQ input", () => {
      const result = gradeMCQOrTF("b", "B", "mcq");
      expect(result.correct).to.be.true;
    });

    it("grades correct true/false answer", () => {
      const result = gradeMCQOrTF("true", "true", "true_false");
      expect(result.correct).to.be.true;
      expect(result.score).to.equal(100);
    });

    it("grades incorrect true/false answer", () => {
      const result = gradeMCQOrTF("true", "false", "true_false");
      expect(result.correct).to.be.false;
      expect(result.score).to.equal(0);
    });

    it("accepts 't' for 'true'", () => {
      expect(gradeMCQOrTF("t", "true", "true_false").correct).to.be.true;
    });

    it("accepts 'f' for 'false'", () => {
      expect(gradeMCQOrTF("f", "false", "true_false").correct).to.be.true;
    });

    it("accepts 'yes' for 'true'", () => {
      expect(gradeMCQOrTF("yes", "true", "true_false").correct).to.be.true;
    });

    it("accepts 'no' for 'false'", () => {
      expect(gradeMCQOrTF("no", "false", "true_false").correct).to.be.true;
    });

    it("has no dimensions (MCQ/TF grading is instant)", () => {
      const result = gradeMCQOrTF("A", "A", "mcq");
      expect(result.dimensions).to.be.undefined;
    });
  });
});
