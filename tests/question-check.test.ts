import { expect } from "chai";
import Database from "better-sqlite3";

import {
  buildQuestionCheckRequest,
  interpretQuestionCheck,
  getQuestionCheckStats,
  __resetQuestionCheckStatsForTest,
} from "../src/services/question-check";
import { generateQuestion } from "../src/services/question-generator";
import { __setQuestionRandomForTest } from "../src/services/question-generation-agent";
import { __setGetConceptsByDifficultyForTest } from "../src/services/kg-store";
import { attachUsageStore, __usageDbForTest } from "../src/services/usage-store";
import type { GeneratedQuestion } from "../src/services/question-generation-agent";
import { stubDecisions, restoreDecisions, decisionsBody, stubChat, restoreChat } from "./helpers/model-stubs";

const mcq: GeneratedQuestion = {
  question: "What does the Cheshire Cat leave behind when it vanishes?",
  options: ["Its grin", "Its tail", "Its collar", "A paw print"],
  correctAnswer: "A",
  type: "mcq",
  targetConcept: "cheshire_cat",
  bloomLevel: "Understand",
  difficulty: 0,
};
const choice = (c: string, confidence = 0.95) => ({ type: "choice" as const, choice: c, probabilities: { [c]: confidence }, confidence });

describe("Question check (Jev, before a question is shown)", () => {
  describe("request + rules", () => {
    it("MCQ: asks which option is correct (criteria = the 4 options) plus answerable / plainly worded / about the work", () => {
      const req = buildQuestionCheckRequest("typesafe/jev-1.13", mcq, "passage text");
      expect(Object.keys(req.questions)).to.deep.equal(["correct_option", "answerable_from_passage", "plainly_worded", "about_the_work"]);
      expect((req.questions.correct_option as any).criteria).to.deep.equal({ A: "Its grin", B: "Its tail", C: "Its collar", D: "A paw print" });
      expect(req.questions.correct_option.instructions).to.equal("Which option is correct according to the passage?");
      expect((req.questions.answerable_from_passage as any).criteria).to.have.keys("yes", "no");
      expect((req.questions.plainly_worded as any).criteria).to.have.keys("yes", "no");
      expect(req.state).to.include({ question: mcq.question, passage: "passage text" });
    });

    it("open / true-false: no option question; the statement is sent as a statement", () => {
      const open = buildQuestionCheckRequest("m", { ...mcq, type: "open", options: undefined, correctAnswer: undefined }, "p");
      expect(Object.keys(open.questions)).to.deep.equal(["answerable_from_passage", "plainly_worded", "about_the_work"]);
      const tf = buildQuestionCheckRequest("m", { ...mcq, type: "true_false", question: "Alice shrinks.", options: undefined, correctAnswer: "true" }, "p");
      expect(tf.state).to.include({ statement: "Alice shrinks." });
      expect(tf.state).to.not.have.property("question");
    });

    it("regenerates when Jev picks another MCQ option with confidence ≥ 0.6 (not below)", () => {
      const base = { answerable_from_passage: choice("yes"), plainly_worded: choice("yes") };
      expect(interpretQuestionCheck(mcq, { ...base, correct_option: choice("B", 0.6) }).reasons).to.deep.equal(["key_mismatch"]);
      expect(interpretQuestionCheck(mcq, { ...base, correct_option: choice("B", 0.59) }).reasons).to.deep.equal([]);
      expect(interpretQuestionCheck(mcq, { ...base, correct_option: choice("A", 0.99) }).reasons).to.deep.equal([]);
    });

    it("regenerates when answerable / plainly worded is 'no' with confidence ≥ 0.7 (not below)", () => {
      const ok = { correct_option: choice("A") };
      expect(interpretQuestionCheck(mcq, { ...ok, answerable_from_passage: choice("no", 0.7), plainly_worded: choice("yes") }).reasons)
        .to.deep.equal(["not_answerable"]);
      expect(interpretQuestionCheck(mcq, { ...ok, answerable_from_passage: choice("yes"), plainly_worded: choice("no", 0.9) }).reasons)
        .to.deep.equal(["not_plain"]);
      expect(interpretQuestionCheck(mcq, { ...ok, answerable_from_passage: choice("no", 0.69), plainly_worded: choice("no", 0.5) }).reasons)
        .to.deep.equal([]);
    });
  });

  describe("generateQuestion() with the check", () => {
    let db: Database.Database;
    beforeEach(() => {
      db = new Database(":memory:");
      attachUsageStore(db);
      __resetQuestionCheckStatsForTest();
      // Options keep the generated order here (an RNG near 1 makes the Fisher–Yates shuffle the identity).
      __setQuestionRandomForTest(() => 0.999999);
      __setGetConceptsByDifficultyForTest(async () => ({
        concepts: [{ id: "cheshire_cat", label: "Cheshire Cat", bloomLevel: "Understand", importance: 8 }],
        subgraph: { nodes: [], edges: [] },
      }));
    });
    afterEach(() => {
      __setQuestionRandomForTest(null);
      restoreDecisions();
      restoreChat();
      attachUsageStore(null);
      db.close();
      __setGetConceptsByDifficultyForTest(null);
    });

    const generated = (n: number) => ({
      question: n === 1 ? "In what ways does the Cheshire Cat's vanishing reflect the epistemological themes?" : "What does the Cheshire Cat leave behind when it vanishes?",
      options: ["Its grin", "Its tail", "Its collar", "A paw print"],
      correctAnswer: "A",
      targetConcept: "cheshire_cat",
      bloomLevel: "Understand",
      difficulty: 0,
    });

    it("passes a good question through (one generation, one check)", async () => {
      const chat = stubChat((_c, n) => generated(n + 1));
      const dec = stubDecisions(() => decisionsBody({ correct_option: ["A", 0.9], answerable_from_passage: ["yes", 0.9], plainly_worded: ["yes", 0.9], about_the_work: ["yes", 0.9] }));
      const q = await generateQuestion(1, "passage", 0, [], "mcq");
      expect(q.question).to.equal("What does the Cheshire Cat leave behind when it vanishes?");
      expect(chat).to.have.length(1);
      expect(dec).to.have.length(1);
      expect(getQuestionCheckStats()).to.deep.include({ checked: 1, passed: 1, regenerated: 0 });
      const row = __usageDbForTest()!.prepare("SELECT task, outcome FROM llm_calls WHERE task = 'question_check'").get();
      expect(row).to.deep.equal({ task: "question_check", outcome: "pass" });
    });

    it("regenerates ONCE with feedback when flagged, and keeps the new question without re-checking", async () => {
      const chat = stubChat((_c, n) => generated(n));
      const dec = stubDecisions(() => decisionsBody({ correct_option: ["A", 0.9], answerable_from_passage: ["yes", 0.9], plainly_worded: ["no", 0.95], about_the_work: ["yes", 0.9] }));
      const q = await generateQuestion(1, "passage", 0, [], "mcq");
      expect(chat).to.have.length(2);
      expect(dec).to.have.length(1); // never loops
      expect(q.question).to.equal("What does the Cheshire Cat leave behind when it vanishes?");
      expect(chat[1].user).to.contain("EVALUATOR_FEEDBACK").and.contain("not plainly worded");
      expect(chat[1].user).to.contain("epistemological"); // the rejected question is named (and listed as previous)
      expect(getQuestionCheckStats()).to.deep.include({ checked: 1, regenerated: 1 });
      expect(getQuestionCheckStats().reasons.not_plain).to.equal(1);
      const row = __usageDbForTest()!.prepare("SELECT outcome FROM llm_calls WHERE task = 'question_check'").get();
      expect(row).to.deep.equal({ outcome: "regenerate:not_plain" });
    });

    it("an MCQ whose key looks wrong is regenerated with the option Jev picked in the feedback", async () => {
      const chat = stubChat((_c, n) => (n === 1 ? generated(2) : { ...generated(2), question: "Where does Alice first meet the Cheshire Cat?" }));
      stubDecisions(() => decisionsBody({ correct_option: ["C", 0.8], answerable_from_passage: ["yes", 0.9], plainly_worded: ["yes", 0.9], about_the_work: ["yes", 0.9] }));
      await generateQuestion(1, "passage", 0, [], "mcq");
      expect(chat).to.have.length(2);
      expect(chat[1].user).to.contain('the passage seems to support "Its collar", not "Its grin"');
    });

    it("keeps the question when the check errors", async () => {
      const chat = stubChat((_c, n) => generated(n + 1));
      stubDecisions(() => new Response("nope", { status: 400 }));
      const q = await generateQuestion(1, "passage", 0, [], "mcq");
      expect(chat).to.have.length(1);
      expect(q.question).to.equal("What does the Cheshire Cat leave behind when it vanishes?");
      expect(getQuestionCheckStats().errors).to.equal(1);
    });

    it("keeps the original question when the regeneration fails", async () => {
      const chat = stubChat((_c, n) => (n === 1 ? generated(1) : "<<not json>>"));
      stubDecisions(() => decisionsBody({ correct_option: ["A", 0.9], answerable_from_passage: ["no", 0.9], plainly_worded: ["yes", 0.9], about_the_work: ["yes", 0.9] }));
      const q = await generateQuestion(1, "passage", 0, [], "mcq");
      expect(chat.length).to.be.greaterThan(1);
      expect(q.question).to.contain("epistemological");
    });
  });
});

describe("Question generation — duplicate retries name the rejected question", () => {
  beforeEach(() => {
    __setGetConceptsByDifficultyForTest(async () => ({ concepts: [], subgraph: { nodes: [], edges: [] } }));
  });
  afterEach(() => {
    restoreChat();
    __setGetConceptsByDifficultyForTest(null);
  });

  it("a near-duplicate is listed under REJECTED_AS_DUPLICATE on the retry (temperature alone may not change the output)", async () => {
    const dup = "Why is it always six o'clock at the Mad Tea-Party?";
    const chat = stubChat((_c, n) => ({
      question: n === 1 ? "Why is it always six o'clock at the Mad Tea Party?" : "Who sleeps between the Hatter and the March Hare?",
      modelAnswer: "x", keyPoints: ["x"], targetConcept: "dormouse", bloomLevel: "Remember", difficulty: -1,
    }));
    const q = await generateQuestion(1, "passage", -1, [dup], "open");
    expect(q.question).to.equal("Who sleeps between the Hatter and the March Hare?");
    expect(chat).to.have.length(2);
    expect(chat[0].user).to.not.contain("REJECTED_AS_DUPLICATE");
    expect(chat[1].user).to.contain("REJECTED_AS_DUPLICATE").and.contain("Why is it always six o'clock at the Mad Tea Party?");
  });
});
