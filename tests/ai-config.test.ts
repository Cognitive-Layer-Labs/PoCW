import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  __resetAIConfigForTest,
  AIConfigError,
  decisionsModel,
  loadAIConfig,
  modelSpec,
  parseModelSpec,
  promptFor,
  resolveAIConfigPath,
  titleModelSpec,
  PROJECT_ROOT,
} from "../src/services/ai-config";
import { buildChatBody, chatCompletion, extractJSONObject } from "../src/services/llm-client";
import { stubChat, restoreChat } from "./helpers/model-stubs";

describe("AI config (ai-config.ts)", () => {
  const saved = process.env.AI_CONFIG_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.AI_CONFIG_PATH;
    else process.env.AI_CONFIG_PATH = saved;
    __resetAIConfigForTest();
  });

  it("loads ai-config.yml by default: Haiku 5.5 / GPT-6 Luna / gpt-5-nano / Jev, with reasoning + fallbacks", () => {
    delete process.env.AI_CONFIG_PATH;
    __resetAIConfigForTest();
    expect(loadAIConfig().path).to.equal(path.join(PROJECT_ROOT, "ai-config.yml"));
    expect(modelSpec("kg-model")).to.deep.equal({
      model: "anthropic/claude-haiku-5.5", fallbacks: ["google/gemini-2.5-flash"], reasoning: { effort: "low" },
    });
    for (const key of ["kaqg-model", "kaqg-mcq-model", "kaqg-tf-model"]) {
      expect(modelSpec(key)).to.deep.equal({
        model: "anthropic/claude-haiku-5.5", fallbacks: ["google/gemini-2.5-flash"], reasoning: { enabled: false },
      });
    }
    expect(modelSpec("grade-model")).to.deep.equal({
      model: "openai/gpt-6-luna", fallbacks: ["google/gemini-2.5-flash"], reasoning: { effort: "low" },
    });
    // gpt-5-nano rejects reasoning "off" (400 "Reasoning is mandatory") → minimal
    expect(titleModelSpec()).to.deep.equal({ model: "openai/gpt-5-nano", fallbacks: [], reasoning: { effort: "minimal" } });
    expect(decisionsModel("question-check-model")).to.equal("typesafe/jev-1.13");
    expect(decisionsModel("grade-decisions-model")).to.equal("typesafe/jev-1.13");
  });

  it("AI_CONFIG_PATH=ai-config.baseline.yml loads the pre-switch setup (all gemini-2.5-flash, no Jev)", () => {
    process.env.AI_CONFIG_PATH = "ai-config.baseline.yml";
    __resetAIConfigForTest();
    expect(loadAIConfig().path).to.equal(path.join(PROJECT_ROOT, "ai-config.baseline.yml"));
    for (const key of ["kg-model", "kaqg-model", "kaqg-mcq-model", "kaqg-tf-model", "grade-model"]) {
      expect(modelSpec(key), key).to.deep.equal({ model: "google/gemini-2.5-flash", fallbacks: [] });
    }
    expect(titleModelSpec().model).to.equal("google/gemini-2.5-flash");
    expect(decisionsModel("question-check-model")).to.equal(undefined);
    expect(decisionsModel("grade-decisions-model")).to.equal(undefined);
    expect(promptFor("grade-prompt")).to.contain("covered_points"); // legacy grade format
  });

  it("the baseline file is the old config verbatim below its header", () => {
    const baseline = fs.readFileSync(path.join(PROJECT_ROOT, "ai-config.baseline.yml"), "utf8");
    expect(baseline).to.match(/^# =+\n# Models\/prompts before the 2026-10-10 switch — all google\/gemini-2\.5-flash;\n# restore by copying over ai-config\.yml/);
    expect(baseline).to.contain('kg-model: "google/gemini-2.5-flash"');
    expect(baseline).to.not.match(/claude|gpt-|jev/i);
  });

  it("resolves absolute and relative AI_CONFIG_PATH values; empty means the default", () => {
    expect(resolveAIConfigPath("")).to.equal(path.join(PROJECT_ROOT, "ai-config.yml"));
    expect(resolveAIConfigPath("  ")).to.equal(path.join(PROJECT_ROOT, "ai-config.yml"));
    expect(resolveAIConfigPath("/etc/x.yml")).to.equal("/etc/x.yml");
    expect(resolveAIConfigPath("ai-config.baseline.yml")).to.equal(path.join(PROJECT_ROOT, "ai-config.baseline.yml"));
  });

  it("rejects a config file with missing keys or bad model entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pocw-aicfg-"));
    try {
      const file = path.join(dir, "bad.yml");
      fs.writeFileSync(file, "kg-model: google/gemini-2.5-flash\n");
      process.env.AI_CONFIG_PATH = file;
      __resetAIConfigForTest();
      expect(() => loadAIConfig()).to.throw(AIConfigError);

      process.env.AI_CONFIG_PATH = path.join(dir, "missing.yml");
      __resetAIConfigForTest();
      expect(() => loadAIConfig()).to.throw(AIConfigError, /not found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses model entries: plain ids, objects, reasoning shorthands, fallbacks", () => {
    expect(parseModelSpec("a/b", "x")).to.deep.equal({ model: "a/b", fallbacks: [] });
    expect(parseModelSpec({ model: "a/b", reasoning: "off" }, "x").reasoning).to.deep.equal({ enabled: false });
    expect(parseModelSpec({ model: "a/b", reasoning: false }, "x").reasoning).to.deep.equal({ enabled: false });
    expect(parseModelSpec({ model: "a/b", reasoning: "minimal" }, "x").reasoning).to.deep.equal({ effort: "minimal" });
    expect(parseModelSpec({ model: "a/b", reasoning: { effort: "high" } }, "x").reasoning).to.deep.equal({ effort: "high" });
    expect(parseModelSpec({ model: "a/b", fallbacks: ["c/d", "a/b", "c/d"] }, "x").fallbacks).to.deep.equal(["c/d"]);
    expect(parseModelSpec({ model: "a/b", fallback: "c/d" }, "x").fallbacks).to.deep.equal(["c/d"]);
    expect(() => parseModelSpec({ model: "a/b", reasoning: "turbo" }, "x")).to.throw(AIConfigError);
    expect(() => parseModelSpec({ reasoning: "low" }, "x")).to.throw(AIConfigError);
    expect(() => parseModelSpec(42, "x")).to.throw(AIConfigError);
  });
});

describe("OpenRouter request fields (llm-client.ts)", () => {
  afterEach(() => restoreChat());

  const spec = { model: "anthropic/claude-haiku-5.5", fallbacks: ["google/gemini-2.5-flash"], reasoning: { effort: "low" as const } };
  const req = { messages: [{ role: "user" as const, content: "hi" }], temperature: 0 };

  it("sends models = [primary, ...fallbacks], reasoning and usage.include", () => {
    expect(buildChatBody(spec, req)).to.deep.equal({
      model: "anthropic/claude-haiku-5.5",
      models: ["anthropic/claude-haiku-5.5", "google/gemini-2.5-flash"],
      reasoning: { effort: "low" },
      usage: { include: true },
      messages: req.messages,
      temperature: 0,
    });
  });

  it("omits models when there are no fallbacks and reasoning when not configured", () => {
    const body = buildChatBody({ model: "openai/gpt-5-nano", fallbacks: [] }, { ...req, max_tokens: undefined });
    expect(body).to.not.have.property("models");
    expect(body).to.not.have.property("reasoning");
    expect(body).to.not.have.property("max_tokens");
    expect(body.usage).to.deep.equal({ include: true });
  });

  it("a caller model override replaces model, fallbacks and reasoning", () => {
    const body = buildChatBody(spec, req, "some/other-model");
    expect(body.model).to.equal("some/other-model");
    expect(body).to.not.have.property("models");
    expect(body).to.not.have.property("reasoning");
  });

  it("chatCompletion passes the built body to the client", async () => {
    const calls = stubChat(() => ({ ok: true }));
    await chatCompletion("question", spec, req);
    expect(calls[0].body.models).to.deep.equal(["anthropic/claude-haiku-5.5", "google/gemini-2.5-flash"]);
    expect(calls[0].body.reasoning).to.deep.equal({ effort: "low" });
    expect(calls[0].body.usage).to.deep.equal({ include: true });
  });

  it("extracts JSON from plain, fenced and prose-wrapped replies", () => {
    expect(extractJSONObject('{"a":1}')).to.deep.equal({ a: 1 });
    expect(extractJSONObject('```json\n{"a":2}\n```')).to.deep.equal({ a: 2 });
    expect(extractJSONObject('Here you go:\n{"a":3}\nHope it helps')).to.deep.equal({ a: 3 });
    expect(() => extractJSONObject("no json here")).to.throw(SyntaxError);
    expect(() => extractJSONObject("[1,2]")).to.throw(SyntaxError);
  });
});
