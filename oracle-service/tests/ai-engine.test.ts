import { expect } from "chai";
import sinon from "sinon";
import * as parser from "../src/services/parser";
import * as aiEngine from "../src/services/ai-engine";

describe("AI Engine comprehensive tests", function () {
  this.timeout(10000);

  let parseStub: sinon.SinonStub;
  let createStub: sinon.SinonStub;

  beforeEach(() => {
    aiEngine.__clearChallengesForTest();

    parseStub = sinon
      .stub(parser, "parseContentToText")
      .resolves("This is a test content about IPFS, decentralization, and blockchain security.");

    createStub = sinon.stub();

    aiEngine.__setOpenAIClientProviderForTest(() => ({
      chat: {
        completions: {
          create: createStub
        }
      }
    } as any));
  });

  afterEach(() => {
    sinon.restore();
  });

  /* ================= BASIC FLOW ================= */

  it("generates a challenge with questions", async () => {
    createStub.resolves({
      choices: [
        {
          message: {
            content: JSON.stringify({
              questions: ["Q1", "Q2", "Q3"]
            })
          }
        }
      ]
    });

    const challenge = await aiEngine.generateChallenge(
      "https://example.com/content.txt",
      "0xUSER"
    );

    expect(challenge.challengeId).to.be.a("string");
    expect(challenge.questions).to.have.length(3);
    expect(challenge.contentText).to.contain("IPFS");
  });

  /* ================= CONTENT LENGTH ================= */

  it("handles very short content", async () => {
    parseStub.restore();
    sinon
      .stub(parser, "parseContentToText")
      .resolves("Short text.");

    createStub.resolves({
      choices: [{ message: { content: '{"questions":[]}' } }]
    });

    const challenge = await aiEngine.generateChallenge(
      "https://example.com/short.txt",
      "0xUSER"
    );

    expect(challenge.questions).to.deep.equal([]);
  });

  it("handles very long content", async () => {
    parseStub.restore();
    sinon
      .stub(parser, "parseContentToText")
      .resolves("A".repeat(50000));

    createStub.resolves({
      choices: [{ message: { content: '{"questions":["Q1","Q2","Q3"]}' } }]
    });

    const challenge = await aiEngine.generateChallenge(
      "https://example.com/long.txt",
      "0xUSER"
    );

    expect(challenge.questions.length).to.equal(3);
  });

  /* ================= JSON ROBUSTNESS ================= */

  it("handles malformed JSON from AI", async () => {
    createStub.resolves({
      choices: [{ message: { content: "NOT_JSON" } }]
    });

    const challenge = await aiEngine.generateChallenge(
      "https://example.com/badjson.txt",
      "0xUSER"
    );

    expect(challenge.questions).to.deep.equal([]);
  });

  it("handles missing questions field", async () => {
    createStub.resolves({
      choices: [{ message: { content: "{}" } }]
    });

    const challenge = await aiEngine.generateChallenge(
      "https://example.com/noquestions.txt",
      "0xUSER"
    );

    expect(challenge.questions).to.deep.equal([]);
  });

  it("ignores extra unexpected JSON fields", async () => {
    createStub.resolves({
      choices: [
        {
          message: {
            content: JSON.stringify({
              questions: ["Q1"],
              garbage: "noise"
            })
          }
        }
      ]
    });

    const challenge = await aiEngine.generateChallenge(
      "https://example.com/extra.json",
      "0xUSER"
    );

    expect(challenge.questions).to.deep.equal(["Q1"]);
  });

  /* ================= ANSWER RECORDING ================= */

  it("records user answers correctly", () => {
    aiEngine.__setChallengeForTest({
      challengeId: "rec-1",
      contentId: 1,
      contentUrl: "x",
      userAddress: "0x",
      questions: ["Q1"]
    });

    aiEngine.recordAnswers("rec-1", ["A1"]);

    const stored = aiEngine.__getChallengeForTest("rec-1");
    expect(stored?.answers).to.deep.equal(["A1"]);
  });

  it("throws when recording answers for missing challenge", () => {
    expect(() => aiEngine.recordAnswers("missing", ["A"])).to.throw(
      "challenge not found"
    );
  });

  /* ================= VERIFICATION ================= */

  it("verifies answers and returns score", async () => {
    aiEngine.__setChallengeForTest({
      challengeId: "verify-1",
      contentId: 1,
      contentUrl: "x",
      userAddress: "0x",
      questions: ["Q1"],
      answers: ["A1"],
      contentText: "Test content"
    });

    createStub.resolves({
      choices: [{ message: { content: '{"score":80}' } }]
    });

    const score = await aiEngine.verifyChallenge("verify-1");
    expect(score).to.equal(80);
  });

  it("defaults score to 0 if JSON is invalid", async () => {
    aiEngine.__setChallengeForTest({
      challengeId: "verify-2",
      contentId: 1,
      contentUrl: "x",
      userAddress: "0x",
      questions: ["Q1"],
      answers: ["A1"],
      contentText: "Test content"
    });

    createStub.resolves({
      choices: [{ message: { content: "bad json" } }]
    });

    const score = await aiEngine.verifyChallenge("verify-2");
    expect(score).to.equal(0);
  });

  it("throws if verify called without answers", async () => {
    aiEngine.__setChallengeForTest({
      challengeId: "verify-3",
      contentId: 1,
      contentUrl: "x",
      userAddress: "0x",
      questions: ["Q1"],
      contentText: "Test content"
    });

    try {
      await aiEngine.verifyChallenge("verify-3");
      throw new Error("should not reach");
    } catch (err: any) {
      expect(err.message).to.contain("answers not recorded");
    }
  });

  it("throws if challenge does not exist", async () => {
    try {
      await aiEngine.verifyChallenge("missing");
      throw new Error("should not reach");
    } catch (err: any) {
      expect(err.message).to.contain("challenge not found");
    }
  });
});
