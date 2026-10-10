import { expect } from "chai";
import sinon from "sinon";

import { __setGetConceptsByDifficultyForTest } from "../src/services/kg-store";
import * as llmClient from "../src/services/llm-client";
import { generateSingleQuestion, gradeAnswer, QuestionGenerationError, GradingError } from "../src/services/question-generator";
import { isTooSimilar } from "../src/services/question-generation-agent";

describe("Question Generator", () => {
  let openAIStub: any;

  beforeEach(() => {
    // Stub KG store to return mock concepts
    __setGetConceptsByDifficultyForTest(async () => ({
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
    }));
  });

  afterEach(() => {
    __setGetConceptsByDifficultyForTest(null);
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

      llmClient.__setOpenAIClientProviderForTest(() => ({
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

    it("throws QuestionGenerationError on malformed LLM response", async () => {
      llmClient.__setOpenAIClientProviderForTest(() => ({
        chat: {
          completions: {
            create: sinon.stub().resolves({
              choices: [{ message: { content: "not json" } }]
            })
          }
        }
      } as any));

      try {
        await generateSingleQuestion(123, "Content...", 0, []);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.instanceOf(QuestionGenerationError);
      }
    });
  });

  describe("gradeAnswer()", () => {
    it("grades a correct answer", async () => {
      const mockGrade = {
        covered_points: 17, total_points: 20, precision_cap: 100,
        correct: true, reasoning: "Good understanding"
      };

      llmClient.__setOpenAIClientProviderForTest(() => ({
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

      expect(result.score).to.equal(85); // 17/20 claims covered
      expect(result.correct).to.be.true;
      expect(result.dimensions!.covered_points).to.equal(17);
      expect(result.dimensions!.total_points).to.equal(20);
      expect(result.dimensions!.precision_cap).to.equal(100);
    });

    it("grades a wrong answer", async () => {
      const mockGrade = {
        covered_points: 3, total_points: 20, precision_cap: 100,
        correct: false, reasoning: "Irrelevant answer"
      };

      llmClient.__setOpenAIClientProviderForTest(() => ({
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
      expect(result.dimensions!.covered_points).to.equal(3);
    });

    it("defaults correct based on threshold when LLM omits it", async () => {
      const mockGrade = {
        covered_points: 7, total_points: 10, precision_cap: 100,
        reasoning: "Decent answer"
      };

      llmClient.__setOpenAIClientProviderForTest(() => ({
        chat: {
          completions: {
            create: sinon.stub().resolves({
              choices: [{ message: { content: JSON.stringify(mockGrade) } }]
            })
          }
        }
      } as any));

      const result = await gradeAnswer("Q?", "A", "S", "c");
      expect(result.score).to.equal(70); // 7/10 claims covered
      expect(result.correct).to.be.true; // 70 >= IRT_CORRECT_THRESHOLD (70)
      expect(result.dimensions!.covered_points).to.equal(7);
    });

    it("throws GradingError on malformed grading response", async () => {
      llmClient.__setOpenAIClientProviderForTest(() => ({
        chat: {
          completions: {
            create: sinon.stub().resolves({
              choices: [{ message: { content: "broken" } }]
            })
          }
        }
      } as any));

      try {
        await gradeAnswer("Q?", "A", "S", "c");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.instanceOf(GradingError);
      }
    });
  });
});

describe("question dedup (isTooSimilar)", () => {
  const previous = [
    "What is the main function of chlorophyll in photosynthesis?",
    "Which molecule is split during the light-dependent reactions?",
  ];

  it("does not flag genuinely different questions", () => {
    // Regression: the Levenshtein *distance* ratio was compared as if it were a similarity,
    // so unrelated questions (distance ≈ 0.8–0.9) were rejected and regenerated at high temperature.
    expect(isTooSimilar("How does the Calvin cycle use ATP and NADPH?", previous)).to.be.false;
    expect(isTooSimilar("Why do plants need carbon dioxide?", previous)).to.be.false;
  });

  it("flags near-duplicates", () => {
    expect(isTooSimilar("What is the main function of chlorophyll during photosynthesis?", previous)).to.be.true;
    expect(isTooSimilar(previous[1], previous)).to.be.true;
  });
});
