import { expect } from "chai";
import sinon from "sinon";

import {
  __setGetConceptsByDifficultyForTest,
  __setGetImportantConceptsForTest,
} from "../src/services/kg-store";
import * as llmClient from "../src/services/llm-client";
import { createHash } from "crypto";
import { VerifySession, pickQuestionType, rankQuestionTypes } from "../src/sdk/verify-session";
import { resolveConfig, PoCWError, QuestionType, VerifyQuestion, PoCWConfig } from "../src/sdk/types";
import { QuestionGenerationError } from "../src/services/question-generator";

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

  it("an active session survives a snapshot round-trip (maxQuestions, se, current question)", async () => {
    stubLLMSequence([openQuestion]);
    const config = resolveConfig({ max_questions: 2, q_types: ["open"] });
    const session = new VerifySession(1, "kid1", chunks, "user1", config);
    await session.init();
    const snap = JSON.parse(JSON.stringify(session.toSnapshot()));
    const restored = VerifySession.fromSnapshot(snap);
    expect(restored.maxQuestions).to.equal(session.maxQuestions);
    expect(restored.currentQuestion).to.deep.equal(session.currentQuestion);
    expect(restored.isActive()).to.be.true;
    expect(JSON.parse(JSON.stringify(restored.toSnapshot()))).to.deep.equal(snap);
    expect((restored as unknown as { irtState: { se: number } }).irtState.se).to.equal(Infinity);

    // Snapshots written before maxQuestions was persisted fall back to the config bounds.
    delete snap.maxQuestions;
    expect(VerifySession.fromSnapshot(snap).maxQuestions).to.equal(2);
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

// ─── Fixed session length, allowed question types, difficulty setting ─────────

type GenKind = QuestionType;
interface LLMCall { kind: GenKind | "grade" | "eval"; user: string }

/**
 * Role-aware LLM stub: answers generation calls with a valid, unique question of the requested
 * type (detected from the system prompt), grades every open answer as correct, and records calls.
 * `failTypes` makes generation of those types return unparseable output (→ QuestionGenerationError).
 */
function stubRoles(opts: { failTypes?: GenKind[]; rating?: number } = {}): LLMCall[] {
  const calls: LLMCall[] = [];
  let n = 0;
  llmClient.__setOpenAIClientProviderForTest(() => ({
    chat: {
      completions: {
        create: sinon.stub().callsFake(async (req: { messages: Array<{ content: string }> }) => {
          const system = req.messages[0]?.content ?? "";
          const user = req.messages[req.messages.length - 1]?.content ?? "";
          let content: string;
          if (user.startsWith("TARGET_BLOOM:")) {
            calls.push({ kind: "eval", user });
            content = JSON.stringify({ pass: true, feedback: "", bloomMatch: true });
          } else if (user.startsWith("QUESTION:")) {
            calls.push({ kind: "grade", user });
            content = JSON.stringify({ covered_points: 4, total_points: 4, precision_cap: 100, correct: true, reasoning: "ok" });
          } else {
            const kind: GenKind = system.includes("multiple-choice") ? "mcq"
              : system.includes("true/false statement") ? "true_false" : "open";
            calls.push({ kind, user });
            const tag = createHash("sha256").update(String(n++)).digest("hex").slice(0, 24);
            const bloomLevel = /TARGET_BLOOM_LEVEL: (\w+)/.exec(user)?.[1] ?? "Understand";
            const base = { targetConcept: "c1", bloomLevel, difficulty: opts.rating ?? 1.0 };
            if (opts.failTypes?.includes(kind)) content = "<<not json>>";
            else if (kind === "mcq") content = JSON.stringify({ ...base, question: `Which statement about ${tag} holds?`, options: ["Opt A", "Opt B", "Opt C", "Opt D"], correctAnswer: "B" });
            else if (kind === "true_false") content = JSON.stringify({ ...base, statement: `The item ${tag} is described in the text.`, correctAnswer: true });
            else content = JSON.stringify({ ...base, question: `What does ${tag} mean?`, referenceKeyPoints: ["point one", "point two"] });
          }
          return { choices: [{ message: { content } }] };
        }),
      },
    },
  } as any));
  return calls;
}

function answerFor(q: VerifyQuestion, correct = true): string {
  if (q.type === "mcq") return correct ? "B" : "A";
  if (q.type === "true_false") return correct ? "true" : "false";
  return "an answer";
}

const generationKinds = (calls: LLMCall[]) => calls.filter(c => c.kind !== "grade" && c.kind !== "eval").map(c => c.kind);

describe("VerifySession — fixed length, allowed types, difficulty", () => {
  const chunks = ["Chunk one content", "Chunk two content", "Chunk three content"];
  const six = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7].map((importance, i) => (
    { id: `c${i + 1}`, label: `Concept ${i + 1}`, bloomLevel: "Understand", importance }
  ));

  beforeEach(() => {
    __setGetConceptsByDifficultyForTest(mockConcepts);
    __setGetImportantConceptsForTest(async () => six);
  });

  afterEach(() => {
    __setGetConceptsByDifficultyForTest(null);
    __setGetImportantConceptsForTest(null);
    sinon.restore();
  });

  /** Drive a session to completion; returns the question numbers seen. Fails on runaway sessions. */
  async function drive(session: VerifySession, expectedTotal: number, correct: (i: number) => boolean = () => true) {
    const numbers: number[] = [];
    for (let i = 0; i < 60; i++) {
      const q = session.currentQuestion;
      expect(q.totalQuestions).to.equal(expectedTotal);
      numbers.push(q.number);
      const fb = await session.submitAnswer(answerFor(q, correct(i)));
      expect(fb.progress.questionNumber).to.equal(i + 1);
      expect(fb.isComplete).to.equal(i + 1 === expectedTotal);
      if (fb.isComplete) return numbers;
    }
    throw new Error("session did not complete");
  }

  describe("question count", () => {
    it("asks exactly max_questions (no expansion to the 6 important concepts), most important first", async () => {
      stubRoles();
      // The landing page's request shape
      const config = resolveConfig({ max_questions: 5, difficulty: 0.2, threshold: 0.35, q_types: ["open", "mcq", "true_false"], response: "detailed" });
      const session = new VerifySession(1, "kid1", chunks, "user1", config);
      await session.init();
      expect(session.importantConceptCount).to.equal(6);
      expect(session.maxQuestions).to.equal(5);

      expect(await drive(session, 5)).to.deep.equal([1, 2, 3, 4, 5]);
      expect(session.isActive()).to.be.false;
      const result = await session.getResult();
      expect(result.questions_asked).to.equal(5);
      expect(result.response_detail!.map(r => r.conceptId)).to.deep.equal(["c1", "c2", "c3", "c4", "c5"]);
    });

    it("keeps the total fixed when the mastery loop retries a failed concept", async () => {
      stubRoles();
      const config = resolveConfig({ max_questions: 5, q_types: ["mcq", "true_false"], response: "detailed" });
      const session = new VerifySession(1, "kid1", chunks, "user1", config);
      await session.init();
      await drive(session, 5, i => i !== 0); // first answer wrong → c1 is re-asked
      const result = await session.getResult();
      expect(result.questions_asked).to.equal(5);
      expect(result.response_detail!.map(r => r.conceptId)).to.deep.equal(["c1", "c1", "c2", "c3", "c4"]);
    });

    it("does not stop early when the IRT converges (old cap: 15 questions)", async () => {
      __setGetImportantConceptsForTest(async () => []);
      stubRoles();
      const config = resolveConfig({ max_questions: 16, q_types: ["mcq"] });
      const session = new VerifySession(1, "kid1", chunks, "user1", config);
      await session.init();
      await drive(session, 16);
      const result = await session.getResult();
      expect(result.questions_asked).to.equal(16);
      expect(result.converged).to.be.true; // reported, but no longer ends the session
    });

    it("a session restored from a snapshot after every answer still asks exactly max_questions", async () => {
      stubRoles();
      const config = resolveConfig({ max_questions: 4, q_types: ["mcq", "true_false"], response: "detailed" });
      let session = new VerifySession(1, "kid1", chunks, "user1", config);
      await session.init();
      expect(session.maxQuestions).to.equal(4);

      const numbers: number[] = [];
      for (let i = 0; i < 20 && !session.isComplete(); i++) {
        // Simulate the HTTP flow: each request rehydrates the session from Redis.
        session = VerifySession.fromSnapshot(JSON.parse(JSON.stringify(session.toSnapshot())));
        session.rehydrateChunks(chunks);
        expect(session.maxQuestions).to.equal(4);
        const q = session.currentQuestion;
        expect(q.totalQuestions).to.equal(4);
        numbers.push(q.number);
        await session.submitAnswer(answerFor(q, i % 2 === 0));
      }
      expect(numbers).to.deep.equal([1, 2, 3, 4]);
      const restored = VerifySession.fromSnapshot(JSON.parse(JSON.stringify(session.toSnapshot())));
      expect(restored.isComplete()).to.be.true;
      expect((await restored.getResult()).questions_asked).to.equal(4);
    });

    it("pre-upgrade snapshots (expanded maxQuestions saved / missing) restore consistently", async () => {
      stubRoles();
      const config = resolveConfig({ max_questions: 3, q_types: ["mcq"] });
      const session = new VerifySession(1, "kid1", chunks, "user1", config);
      await session.init();
      const snap = JSON.parse(JSON.stringify(session.toSnapshot()));
      // A snapshot saved by the old engine keeps the total it already announced to the client.
      expect(VerifySession.fromSnapshot({ ...snap, maxQuestions: 6, config: { ...snap.config, cap_questions: 6 } }).maxQuestions).to.equal(6);
      // No maxQuestions at all → the configured count.
      delete snap.maxQuestions;
      expect(VerifySession.fromSnapshot(snap).maxQuestions).to.equal(3);
    });

    it("resolveConfig: explicit max_questions wins over a preset; preset/default otherwise", () => {
      expect(resolveConfig({ max_questions: 5 }).max_questions).to.equal(5);
      expect(resolveConfig({ difficulty_preset: "medium", max_questions: 5 }).max_questions).to.equal(5);
      expect(resolveConfig({ difficulty_preset: "medium" }).max_questions).to.equal(15);
      expect(resolveConfig({}).max_questions).to.equal(10);
      expect(resolveConfig({})).to.not.have.property("cap_questions");
    });
  });

  describe("question types", () => {
    const ALL: QuestionType[] = ["open", "mcq", "true_false"];
    const subsets: QuestionType[][] = [
      ["open"], ["mcq"], ["true_false"],
      ["mcq", "true_false"], ["open", "true_false"], ["open", "mcq"], ALL,
    ];

    it("pickQuestionType never returns a type outside q_types", () => {
      for (const allowed of subsets) {
        for (let b = -2; b <= 2.0001; b += 0.05) {
          expect(allowed).to.include(pickQuestionType(b, allowed));
          expect([...rankQuestionTypes(b, allowed)].sort()).to.deep.equal([...allowed].sort());
        }
      }
    });

    it("keeps the difficulty-driven choice within the allowed types", () => {
      // all three: TF < −0.5 ≤ MCQ < 0.5 ≤ open (unchanged)
      expect([-1, -0.51, -0.5, 0.49, 0.5, 2].map(b => pickQuestionType(b, ALL)))
        .to.deep.equal(["true_false", "true_false", "mcq", "mcq", "open", "open"]);
      // mcq + true_false (no written answers): TF easy, MCQ harder — never open
      expect([-1.5, -0.6, -0.5, 0.5, 2].map(b => pickQuestionType(b, ["mcq", "true_false"])))
        .to.deep.equal(["true_false", "true_false", "mcq", "mcq", "mcq"]);
      // open + true_false: TF easy, open harder
      expect([-1, -0.01, 0, 1].map(b => pickQuestionType(b, ["open", "true_false"])))
        .to.deep.equal(["true_false", "true_false", "open", "open"]);
      // open + mcq: MCQ easy, open harder
      expect([-2, 0.49, 0.5].map(b => pickQuestionType(b, ["mcq", "open"])))
        .to.deep.equal(["mcq", "mcq", "open"]);
    });

    it("sessions only ever request and ask allowed types, at every difficulty", async () => {
      for (const allowed of subsets) {
        for (const difficulty of [0, 0.2, 0.4, 0.65, 1]) {
          const calls = stubRoles();
          const session = new VerifySession(1, "kid1", chunks, "user1", resolveConfig({ max_questions: 4, difficulty, q_types: allowed }));
          await session.init();
          const asked: QuestionType[] = [];
          for (let i = 0; i < 4; i++) {
            asked.push(session.currentQuestion.type);
            await session.submitAnswer(answerFor(session.currentQuestion));
          }
          expect(session.isComplete()).to.be.true;
          for (const t of [...asked, ...generationKinds(calls)]) {
            expect(allowed, `q_types=${allowed} difficulty=${difficulty}`).to.include(t);
          }
        }
      }
    });

    it("written answers deselected at a hard setting: MCQ instead of open", async () => {
      const calls = stubRoles();
      const session = new VerifySession(1, "kid1", chunks, "user1", resolveConfig({ max_questions: 3, difficulty: 1, q_types: ["mcq", "true_false"] }));
      await session.init();
      expect(session.currentQuestion.type).to.equal("mcq");
      expect(generationKinds(calls)).to.not.include("open");
    });

    it("falls back to another allowed type (never open) when the preferred generator fails", async () => {
      const calls = stubRoles({ failTypes: ["mcq"] });
      // hard → first target 0.25 + 0.135 → MCQ preferred among [mcq, true_false]
      const session = new VerifySession(1, "kid1", chunks, "user1", resolveConfig({ max_questions: 2, difficulty: 0.65, q_types: ["mcq", "true_false"] }));
      await session.init();
      expect(session.currentQuestion.type).to.equal("true_false");
      const kinds = generationKinds(calls);
      expect(kinds).to.include("mcq");
      expect(kinds).to.not.include("open");
    });

    it("throws QuestionGenerationError (no silent switch to open) when every allowed type fails", async () => {
      const calls = stubRoles({ failTypes: ["mcq", "true_false"] });
      const session = new VerifySession(1, "kid1", chunks, "user1", resolveConfig({ max_questions: 2, q_types: ["mcq", "true_false"] }));
      try {
        await session.init();
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).to.be.instanceOf(QuestionGenerationError);
      }
      expect(generationKinds(calls)).to.not.include("open");
    });
  });

  describe("difficulty setting", () => {
    beforeEach(() => {
      __setGetImportantConceptsForTest(async () => six.slice(1, 4)); // importance 0.9, 0.85, 0.8
    });

    const firstQuestion = async (config: PoCWConfig) => {
      const calls = stubRoles();
      const session = new VerifySession(1, "kid1", chunks, "user1", resolveConfig(config));
      await session.init();
      return { session, user: calls[0].user, kind: calls[0].kind };
    };

    it("shifts the Bloom target and type of the first question: easy → Understand/TF, medium → Understand/MCQ, hard → Apply/MCQ, max → Evaluate/open", async () => {
      const all: QuestionType[] = ["open", "mcq", "true_false"];
      const easy = await firstQuestion({ difficulty: 0.2, q_types: all });
      expect(easy.user).to.contain("TARGET_BLOOM_LEVEL: Understand");
      expect(easy.user).to.contain("TARGET_DIFFICULTY: -0.76");
      expect(easy.kind).to.equal("true_false");
      expect(easy.session.currentQuestion.type).to.equal("true_false");

      const medium = await firstQuestion({ difficulty: 0.4, q_types: all });
      expect(medium.user).to.contain("TARGET_BLOOM_LEVEL: Understand");
      expect(medium.kind).to.equal("mcq");

      const hard = await firstQuestion({ difficulty: 0.65, q_types: all });
      expect(hard.user).to.contain("TARGET_BLOOM_LEVEL: Apply");
      expect(hard.kind).to.equal("mcq");

      const max = await firstQuestion({ difficulty: 1, q_types: all });
      expect(max.user).to.contain("TARGET_BLOOM_LEVEL: Evaluate");
      expect(max.kind).to.equal("open");
    });

    it("an easy session stays on Remember/Understand for a learner who misses questions", async () => {
      const calls = stubRoles();
      const session = new VerifySession(1, "kid1", chunks, "user1", resolveConfig({ max_questions: 5, difficulty: 0.2, q_types: ["mcq", "true_false"] }));
      await session.init();
      await drive(session, 5, i => i % 2 === 1);
      const blooms = calls.filter(c => c.kind !== "grade").map(c => /TARGET_BLOOM_LEVEL: (\w+)/.exec(c.user)?.[1]);
      expect(blooms).to.have.length(5);
      for (const b of blooms) expect(["Remember", "Understand"]).to.include(b);
    });

    it("anchors the LLM's difficulty rating to the target before it reaches the IRT update", async () => {
      // LLM rates every question 1.0 (as seen live); easy target is −0.755 → b = −0.755 + 0.25
      const { session } = await firstQuestion({ difficulty: 0.2, q_types: ["mcq", "true_false"] });
      expect(session.currentQuestion.difficulty).to.be.closeTo(-0.505, 1e-9);
      const fb = await session.submitAnswer(answerFor(session.currentQuestion));
      expect(fb.irtParams!.b).to.be.closeTo(-0.505, 1e-9);
    });
  });
});
