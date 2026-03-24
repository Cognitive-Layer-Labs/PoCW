import { expect } from "chai";
import sinon from "sinon";

// Stub external dependencies before importing modules that use them
import * as kgStore from "../src/services/kg-store";
import * as aiEngine from "../src/services/ai-engine";
import { generateSingleQuestion, gradeAnswer } from "../src/services/question-generator";

describe("Question Generator", () => {
  let openAIStub: any;

  beforeEach(() => {
    // Stub KG store to return mock concepts
    sinon.stub(kgStore, "getConceptsByDifficulty").resolves({
      concepts: [
        { id: "proof_of_work", label: "Proof of Work", bloomLevel: "Understand", importance: 8 },
        { id: "mining", label: "Mining", bloomLevel: "Understand", importance: 7 }
      ],
      subgraph: {
        nodes: [
          { id: "proof_of_work", label: "Proof of Work", bloomLevel: "Understand", importance: 8 },
          { id: "mining", label: "Mining", bloomLevel: "Understand", importance: 7 }
        ],
        edges: [
          { source: "proof_of_work", target: "mining", relationship: "implemented_by" }
        ]
      }
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("generateSingleQuestion()", () => {
    it("generates a valid question from LLM response", async () => {
      const mockResponse = {
        question: "What is proof of work?",
        targetConcept: "proof_of_work",
        bloomLevel: "Understand",
        difficulty: -0.5
      };

      aiEngine.__setOpenAIClientProviderForTest(() => ({
        chat: {
          completions: {
            create: sinon.stub().resolves({
              choices: [{ message: { content: JSON.stringify(mockResponse) } }]
            })
          }
        }
      } as any));

      const result = await generateSingleQuestion(123, "Bitcoin content...", -0.5, []);

      expect(result.question).to.equal("What is proof of work?");
      expect(result.targetConcept).to.equal("proof_of_work");
      expect(result.bloomLevel).to.equal("Understand");
      expect(result.difficulty).to.equal(-0.5);
    });

    it("handles malformed LLM response gracefully", async () => {
      aiEngine.__setOpenAIClientProviderForTest(() => ({
        chat: {
          completions: {
            create: sinon.stub().resolves({
              choices: [{ message: { content: "not json" } }]
            })
          }
        }
      } as any));

      const result = await generateSingleQuestion(123, "Content...", 0, []);

      expect(result.question).to.equal("Unable to generate question");
      expect(result.bloomLevel).to.equal("Apply"); // fallback from difficulty=0
    });
  });

  describe("gradeAnswer()", () => {
    it("grades a correct answer", async () => {
      const mockGrade = {
        accuracy: 22, depth: 20, specificity: 23, reasoning_score: 20,
        score: 85, correct: true, reasoning: "Good understanding"
      };

      aiEngine.__setOpenAIClientProviderForTest(() => ({
        chat: {
          completions: {
            create: sinon.stub().resolves({
              choices: [{ message: { content: JSON.stringify(mockGrade) } }]
            })
          }
        }
      } as any));

      const result = await gradeAnswer(
        "What is PoW?",
        "It's a consensus mechanism using computational puzzles",
        "Source text...",
        "proof_of_work"
      );

      expect(result.score).to.equal(85);
      expect(result.correct).to.be.true;
      expect(result.dimensions.accuracy).to.equal(22);
      expect(result.dimensions.depth).to.equal(20);
      expect(result.dimensions.specificity).to.equal(23);
      expect(result.dimensions.reasoning).to.equal(20);
    });

    it("grades a wrong answer", async () => {
      const mockGrade = {
        accuracy: 3, depth: 2, specificity: 5, reasoning_score: 5,
        score: 15, correct: false, reasoning: "Irrelevant answer"
      };

      aiEngine.__setOpenAIClientProviderForTest(() => ({
        chat: {
          completions: {
            create: sinon.stub().resolves({
              choices: [{ message: { content: JSON.stringify(mockGrade) } }]
            })
          }
        }
      } as any));

      const result = await gradeAnswer("What is PoW?", "I don't know", "Source...", "pow");

      expect(result.score).to.equal(15);
      expect(result.correct).to.be.false;
      expect(result.dimensions.accuracy).to.equal(3);
    });

    it("defaults correct based on threshold when LLM omits it", async () => {
      const mockGrade = {
        accuracy: 20, depth: 18, specificity: 17, reasoning_score: 15,
        reasoning: "Decent answer"
      };

      aiEngine.__setOpenAIClientProviderForTest(() => ({
        chat: {
          completions: {
            create: sinon.stub().resolves({
              choices: [{ message: { content: JSON.stringify(mockGrade) } }]
            })
          }
        }
      } as any));

      const result = await gradeAnswer("Q?", "A", "S", "c");
      expect(result.score).to.equal(70); // 20+18+17+15 = 70
      expect(result.correct).to.be.true; // 70 >= 60
      expect(result.dimensions.accuracy).to.equal(20);
    });

    it("handles malformed grading response", async () => {
      aiEngine.__setOpenAIClientProviderForTest(() => ({
        chat: {
          completions: {
            create: sinon.stub().resolves({
              choices: [{ message: { content: "broken" } }]
            })
          }
        }
      } as any));

      const result = await gradeAnswer("Q?", "A", "S", "c");
      expect(result.score).to.equal(0);
      expect(result.correct).to.be.false;
      expect(result.dimensions.accuracy).to.equal(0);
      expect(result.dimensions.depth).to.equal(0);
    });
  });
});
