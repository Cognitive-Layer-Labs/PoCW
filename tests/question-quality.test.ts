import { expect } from "chai";

import {
  shuffleMCQOptions,
  cleanQuestionWording,
  styleProblem,
  dropRestatedKeyPoints,
  __setQuestionRandomForTest,
  GeneratedQuestion,
} from "../src/services/question-generation-agent";
import {
  buildQuestionCheckRequest,
  interpretQuestionCheck,
  regenerationFeedback,
  getQuestionCheckStats,
  __resetQuestionCheckStatsForTest,
} from "../src/services/question-check";
import { generateQuestion } from "../src/services/question-generator";
import { __setGetConceptsByDifficultyForTest } from "../src/services/kg-store";
import { frontMatterChunks, preferBodyChunks } from "../src/services/session-manager";
import { stubDecisions, restoreDecisions, decisionsBody, stubChat, restoreChat } from "./helpers/model-stubs";

/** Small seeded PRNG (mulberry32) for reproducible shuffles. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = ["A", "B", "C", "D"];
const keyText = (q: GeneratedQuestion) => q.options![LETTERS.indexOf(q.correctAnswer!)];

const mcq: GeneratedQuestion = {
  question: "What does the Cheshire Cat leave behind when it vanishes?",
  options: ["Its grin", "Its tail", "Its collar", "A paw print"],
  correctAnswer: "A",
  type: "mcq",
  targetConcept: "cheshire_cat",
  bloomLevel: "Understand",
  difficulty: 0,
};

describe("Question quality fixes", () => {
  afterEach(() => __setQuestionRandomForTest(null));

  describe("MCQ options are shuffled in code", () => {
    it("the key's position is uniformly distributed (seeded RNG, 8000 shuffles) and always points at the right text", () => {
      const rng = seeded(42);
      const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
      const N = 8000;
      for (let i = 0; i < N; i++) {
        const q = shuffleMCQOptions(mcq, rng);
        counts[q.correctAnswer!]++;
        expect(keyText(q)).to.equal("Its grin");
        expect(q.options).to.have.members(mcq.options!);
      }
      // χ² with 3 degrees of freedom; 16.27 is the p = 0.001 critical value.
      const chi2 = Object.values(counts).reduce((s, c) => s + (c - N / 4) ** 2 / (N / 4), 0);
      expect(chi2, JSON.stringify(counts)).to.be.lessThan(16.27);
      for (const c of Object.values(counts)) expect(c).to.be.within(N / 4 - 200, N / 4 + 200);
      expect(mcq.correctAnswer).to.equal("A"); // input not mutated
    });

    it("whatever key the model gave, the shown key is remapped (B → text of B)", () => {
      const rng = seeded(7);
      for (let i = 0; i < 50; i++) {
        expect(keyText(shuffleMCQOptions({ ...mcq, correctAnswer: "B" }, rng))).to.equal("Its tail");
      }
    });

    it("leaves non-MCQ / malformed questions alone", () => {
      const tf: GeneratedQuestion = { ...mcq, type: "true_false", options: undefined, correctAnswer: "true" };
      expect(shuffleMCQOptions(tf)).to.equal(tf);
      const bad = { ...mcq, options: ["a", "b", "c"] };
      expect(shuffleMCQOptions(bad)).to.equal(bad);
    });

    describe("in generateQuestion() (generation, check and regeneration)", () => {
      beforeEach(() => {
        __resetQuestionCheckStatsForTest();
        __setGetConceptsByDifficultyForTest(async () => ({
          concepts: [{ id: "cheshire_cat", label: "Cheshire Cat", bloomLevel: "Understand", importance: 8 }],
          subgraph: { nodes: [], edges: [] },
        }));
      });
      afterEach(() => {
        restoreDecisions();
        restoreChat();
        __setGetConceptsByDifficultyForTest(null);
      });

      it("the model always answers A, the learner sees every position; Jev's key check uses the shuffled key", async () => {
        __setQuestionRandomForTest(seeded(2026));
        stubChat(() => ({ ...mcq, question: "What does the Cheshire Cat leave behind when it vanishes?" }));
        // Jev answers with the letter of "Its grin" in the order it was shown → must pass.
        const dec = stubDecisions(body => {
          const criteria = body.questions.correct_option.criteria as Record<string, string>;
          const letter = Object.keys(criteria).find(k => criteria[k] === "Its grin")!;
          return decisionsBody({ correct_option: [letter, 0.95], answerable_from_passage: ["yes", 0.9], plainly_worded: ["yes", 0.9], about_the_work: ["yes", 0.9] });
        });
        const seen = new Set<string>();
        for (let i = 0; i < 24; i++) {
          const q = await generateQuestion(1, "passage", 0, [], "mcq");
          seen.add(q.correctAnswer!);
          expect(keyText(q)).to.equal("Its grin");
        }
        expect([...seen].sort()).to.deep.equal(["A", "B", "C", "D"]);
        expect(dec).to.have.length(24);
        expect(getQuestionCheckStats()).to.deep.include({ checked: 24, passed: 24, regenerated: 0 });
      });

      it("a regenerated MCQ is shuffled too", async () => {
        __setQuestionRandomForTest(seeded(99));
        const chat = stubChat((_c, n) => ({ ...mcq, question: n % 2 === 1 ? "Which item stays in the air after the Cat vanishes?" : "What is left when the Cheshire Cat fades away?" }));
        stubDecisions(() => decisionsBody({ correct_option: ["A", 0.9], answerable_from_passage: ["no", 0.95], plainly_worded: ["yes", 0.9], about_the_work: ["yes", 0.9] }));
        const keys = new Set<string>();
        for (let i = 0; i < 12; i++) {
          const q = await generateQuestion(1, "passage", 0, [], "mcq");
          expect(q.question).to.equal("What is left when the Cheshire Cat fades away?");
          expect(keyText(q)).to.equal("Its grin");
          keys.add(q.correctAnswer!);
        }
        expect(keys.size).to.be.greaterThan(1);
        expect(chat.length).to.equal(24);
      });
    });
  });

  describe("banned source phrasing is stripped", () => {
    const cases: Array<[string, string]> = [
      ["According to this passage, why does Alice follow the White Rabbit?", "Why does Alice follow the White Rabbit?"],
      ["In the passage, who is always late?", "Who is always late?"],
      ["What must a general know about the enemy, according to the commentators' explanation?", "What must a general know about the enemy?"],
      ["Why should a general avoid long wars, according to the text?", "Why should a general avoid long wars?"],
      ["According to the author, what is the supreme art of war?", "What is the supreme art of war?"],
      ["As the passage explains, what does the Cat leave behind?", "What does the Cat leave behind?"],
      ["Based on the excerpt, the Hatter quarrelled with Time.", "The Hatter quarrelled with Time."],
      ["The Duchess has a baby that turns into a pig, according to the passage.", "The Duchess has a baby that turns into a pig."],
      ["According to the passage's advice, why should a general keep the place of battle secret?", "Why should a general keep the place of battle secret?"],
      ["In this excerpt's opening, what is Alice doing?", "What is Alice doing?"],
      ["Who does Alice meet in the garden?", "Who does Alice meet in the garden?"],
      ["According to Sun Tzŭ, what is the supreme art of war?", "According to Sun Tzŭ, what is the supreme art of war?"],
    ];
    for (const [raw, clean] of cases) {
      it(`"${raw}"`, () => expect(cleanQuestionWording(raw)).to.equal(clean));
    }
  });

  describe("cheap style check (one regeneration)", () => {
    const tf = (statement: string): GeneratedQuestion =>
      ({ question: statement, type: "true_false", correctAnswer: "true", targetConcept: "x", bloomLevel: "Remember", difficulty: -1 });

    it("flags long or compound true/false statements and questions that mention a passage", () => {
      expect(styleProblem(tf("Sun Tzŭ's family comes from Lo-an, and the author says his ancestor's work was read only as literature, without grasping its military technique."))).to.be.a("string");
      expect(styleProblem(tf("The Hatter says he and the March Hare quarrelled with Time last March, just before the March Hare went mad."))).to.be.a("string");
      expect(styleProblem(tf("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix"))).to.contain("26 words");
      expect(styleProblem(tf("Alice shrinks after drinking from the bottle."))).to.equal(null);
      expect(styleProblem(tf("It is always six o'clock at the tea-party because the Hatter quarrelled with Time."))).to.equal(null);
      expect(styleProblem({ ...mcq, question: "What does the passage say about the Cat?" })).to.contain("passage");
      expect(styleProblem(mcq)).to.equal(null);
    });

    describe("in generation", () => {
      beforeEach(() => {
        __setGetConceptsByDifficultyForTest(async () => ({ concepts: [], subgraph: { nodes: [], edges: [] } }));
      });
      afterEach(() => {
        restoreChat();
        __setGetConceptsByDifficultyForTest(null);
      });

      const long = "The Hatter says he and the March Hare quarrelled with Time last March, just before the March Hare went mad.";
      const tfPayload = (statement: string) => ({ statement, correctAnswer: true, targetConcept: "hatter", bloomLevel: "Remember", difficulty: -1 });

      it("a compound TF statement is rewritten once, with the reason in the prompt", async () => {
        const chat = stubChat((_c, n) => tfPayload(n === 1 ? long : "The Hatter quarrelled with Time."));
        const q = await generateQuestion(1, "passage", -1, [], "true_false");
        expect(q.question).to.equal("The Hatter quarrelled with Time.");
        expect(chat).to.have.length(2);
        expect(chat[1].user).to.contain("REWRITE_NEEDED").and.contain(long).and.contain("ONE simple claim");
      });

      it("only once: a second bad statement is kept (no loop)", async () => {
        const chat = stubChat(() => tfPayload(long));
        const q = await generateQuestion(1, "passage", -1, [], "true_false");
        expect(q.question).to.equal(long);
        expect(chat).to.have.length(2);
      });

      it("a question that still mentions the passage after clean-up is rewritten once", async () => {
        const chat = stubChat((_c, n) => ({
          question: n === 1 ? "What does the passage say about the Queen's croquet game?" : "What do the players use as croquet mallets?",
          modelAnswer: "Flamingos.", keyPoints: ["Live flamingos"], targetConcept: "croquet", bloomLevel: "Remember", difficulty: 0,
        }));
        const q = await generateQuestion(1, "passage", 0, [], "open");
        expect(q.question).to.equal("What do the players use as croquet mallets?");
        expect(chat).to.have.length(2);
      });
    });
  });

  describe("key points answer the question", () => {
    it("drops key points that only restate the question (keeps the list if nothing else is left)", () => {
      const q = "Why does the Cat say the Hatter and the March Hare are both mad?";
      expect(dropRestatedKeyPoints(q, ["The Hatter and March Hare are both mad", "Everyone in Wonderland is mad, says the Cat"]))
        .to.deep.equal(["Everyone in Wonderland is mad, says the Cat"]);
      expect(dropRestatedKeyPoints(q, ["The Hatter and March Hare are both mad"])).to.deep.equal(["The Hatter and March Hare are both mad"]);
      expect(dropRestatedKeyPoints("Who is always late?", ["The White Rabbit"])).to.deep.equal(["The White Rabbit"]);
    });
  });

  describe("question check: true/false key", () => {
    const choice = (c: string, confidence = 0.95) => ({ type: "choice" as const, choice: c, probabilities: { [c]: confidence }, confidence });
    const tf: GeneratedQuestion = { ...mcq, type: "true_false", question: "The Cheshire Cat's grin stays behind after the Cat vanishes.", options: undefined, correctAnswer: "false" };
    const ok = { answerable_from_passage: choice("yes"), plainly_worded: choice("yes"), about_the_work: choice("yes") };

    it("asks whether the statement is true (only for true/false)", () => {
      expect(buildQuestionCheckRequest("m", tf, "p").questions).to.have.property("statement_true");
      expect(buildQuestionCheckRequest("m", mcq, "p").questions).to.not.have.property("statement_true");
    });

    it("a key Jev disagrees with (confidence ≥ 0.6) → key_mismatch, with the right answer in the feedback", () => {
      const flagged = interpretQuestionCheck(tf, { ...ok, statement_true: choice("true", 0.9) });
      expect(flagged.reasons).to.deep.equal(["key_mismatch"]);
      expect(regenerationFeedback(tf, flagged.reasons, flagged.jevChoice)).to.contain("statement is TRUE, but it was marked FALSE");
      expect(interpretQuestionCheck(tf, { ...ok, statement_true: choice("true", 0.59) }).reasons).to.deep.equal([]);
      expect(interpretQuestionCheck(tf, { ...ok, statement_true: choice("false", 0.99) }).reasons).to.deep.equal([]);
    });
  });

  describe("question check: about_the_work", () => {
    const choice = (c: string, confidence = 0.95) => ({ type: "choice" as const, choice: c, probabilities: { [c]: confidence }, confidence });
    const ok = { correct_option: choice("A"), answerable_from_passage: choice("yes"), plainly_worded: choice("yes") };

    it("is asked in the same single call, for every type", () => {
      const req = buildQuestionCheckRequest("typesafe/jev-1.13", mcq, "passage");
      expect(Object.keys(req.questions)).to.deep.equal(["correct_option", "answerable_from_passage", "plainly_worded", "about_the_work"]);
      expect((req.questions.about_the_work as any).criteria).to.have.keys("yes", "no");
      const tf = buildQuestionCheckRequest("m", { ...mcq, type: "true_false", options: undefined, correctAnswer: "true" }, "p");
      expect(tf.questions).to.have.property("about_the_work");
    });

    it("\"no\" with confidence ≥ 0.7 → regenerate (not below), with front-matter feedback", () => {
      expect(interpretQuestionCheck(mcq, { ...ok, about_the_work: choice("no", 0.7) }).reasons).to.deep.equal(["not_about_work"]);
      expect(interpretQuestionCheck(mcq, { ...ok, about_the_work: choice("no", 0.69) }).reasons).to.deep.equal([]);
      expect(interpretQuestionCheck(mcq, ok).reasons).to.deep.equal([]); // older answers without the choice
      expect(regenerationFeedback(mcq, ["not_about_work"])).to.contain("introduction, translator");
    });

    describe("in generateQuestion()", () => {
      beforeEach(() => {
        __resetQuestionCheckStatsForTest();
        __setGetConceptsByDifficultyForTest(async () => ({ concepts: [], subgraph: { nodes: [], edges: [] } }));
      });
      afterEach(() => {
        restoreDecisions();
        restoreChat();
        __setGetConceptsByDifficultyForTest(null);
      });

      it("a question about the translator's introduction is regenerated once", async () => {
        const chat = stubChat((_c, n) => ({
          question: n === 1 ? "Which state did Sun Tzŭ probably come from, scholars think?" : "Why should a general avoid a long war?",
          modelAnswer: "x", keyPoints: ["x"], targetConcept: "war", bloomLevel: "Understand", difficulty: 0,
        }));
        const dec = stubDecisions(() => decisionsBody({ answerable_from_passage: ["yes", 0.9], plainly_worded: ["yes", 0.9], about_the_work: ["no", 0.85] }));
        const q = await generateQuestion(1, "passage", 0, [], "open");
        expect(q.question).to.equal("Why should a general avoid a long war?");
        expect(chat).to.have.length(2);
        expect(dec).to.have.length(1);
        expect(chat[1].user).to.contain("front or back matter");
        expect(getQuestionCheckStats().reasons.not_about_work).to.equal(1);
      });
    });
  });

  describe("front matter chunks", () => {
    const filler = (word: string) => `${word} `.repeat(700);

    it("everything before the first chapter of a book that opens with contents / introduction", () => {
      const chunks = [
        "Contents\nPreface\nINTRODUCTION\nChapter I. Laying plans\nChapter II. Waging War\nChapter III. Attack by Stratagem\n" + filler("intro"),
        ...Array.from({ length: 4 }, () => filler("scholars")),
        "end of the bibliography.\nChapter I. LAYING PLANS\n1. Sun Tzŭ said: The art of war is of vital importance to the State. " + filler("war"),
        ...Array.from({ length: 14 }, () => filler("war")),
      ];
      expect([...frontMatterChunks(chunks)]).to.deep.equal([0, 1, 2, 3, 4]);
    });

    it("no front matter when the first chapter starts in the first chunk (Alice), or for short texts", () => {
      const alice = [
        "Contents\nCHAPTER I. Down the Rabbit-Hole CHAPTER II. The Pool of Tears\nCHAPTER I.\nDown the Rabbit-Hole\nAlice was beginning to get very tired of sitting by her sister on the bank. " + filler("alice"),
        ...Array.from({ length: 12 }, () => filler("alice")),
      ];
      expect(frontMatterChunks(alice).size).to.equal(0);
      expect(frontMatterChunks(["INTRODUCTION\n" + filler("x"), filler("y")]).size).to.equal(0);
    });

    it("without a chapter heading: chunks in the first ~10% that carry a preface / translator heading", () => {
      const chunks = ["PREFACE\n" + filler("p"), "Translated by Someone\n" + filler("t"), ...Array.from({ length: 18 }, () => filler("body"))];
      expect([...frontMatterChunks(chunks)]).to.deep.equal([0, 1]);
    });

    it("preferBodyChunks: body candidates first, then any body chunk, else the original candidates", () => {
      const fm = new Set([0, 1, 2]);
      expect(preferBodyChunks([1, 5, 7], 10, fm)).to.deep.equal([5, 7]);
      expect(preferBodyChunks([1, 2], 5, fm)).to.deep.equal([3, 4]);
      expect(preferBodyChunks([], 5, fm)).to.deep.equal([3, 4]);
      expect(preferBodyChunks([0, 1], 3, fm)).to.deep.equal([0, 1]);
      expect(preferBodyChunks([0, 1], 3, new Set())).to.deep.equal([0, 1]);
    });
  });
});
