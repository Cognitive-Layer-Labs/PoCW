import { expect } from "chai";
import sinon from "sinon";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { PoCW } from "../src/sdk/index";
import * as llmClient from "../src/services/llm-client";
import { closeContentStore, getContent, listContent, initContentStore, updateMetadata, insertContent } from "../src/sdk/content-store";
import { parseUpload } from "../src/services/parser";
import { gutenbergText, makeEpub } from "./helpers/fixtures";

/** LLM stub: every KG extraction returns the same two concepts. */
function stubKgLLM(): sinon.SinonStub {
  const create = sinon.stub().callsFake(async () => ({
    choices: [{ message: { content: JSON.stringify({
      nodes: [
        { id: "a", label: "Captain Ahab", bloomLevel: "Understand", importance: 9 },
        { id: "b", label: "The White Whale", bloomLevel: "Remember", importance: 8 },
      ],
      edges: [{ source: "a", target: "b", relationship: "hunts" }],
    }) } }],
  }));
  llmClient.__setOpenAIClientProviderForTest(() => ({ chat: { completions: { create } } } as any));
  return create;
}

describe("Book indexing (SDK)", function () {
  this.timeout(20000);
  let dir: string;
  let pocw: PoCW;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pocw-book-"));
    closeContentStore(); // the content store is a module singleton — never reuse another test's DB
    pocw = new PoCW({ dbPath: path.join(dir, "pocw.db") });
    await pocw.init(); // FalkorDB is unreachable in tests → graph storage is skipped
  });

  afterEach(async () => {
    await pocw.close();
    sinon.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores the title/author found in an uploaded EPUB and returns the author in the status", async () => {
    stubKgLLM();
    const doc = await parseUpload(makeEpub({ title: "Moby-Dick", creators: [{ name: "Herman Melville", role: "aut" }] }), "application/epub+zip");
    const { knowledgeId } = await pocw.index(doc.text, { asText: true, meta: { title: doc.title, author: doc.author } });
    const status = await pocw.waitForIndex(knowledgeId, 10_000);
    expect(status.status).to.equal("ready");
    expect(status.author).to.equal("Herman Melville");
    expect(getContent(knowledgeId)!.title).to.equal("Moby-Dick");
    expect(listContent().rows[0].author).to.equal("Herman Melville");

    // Re-indexing an upload keeps the metadata found at upload time.
    await pocw.reindexResource(knowledgeId);
    await pocw.waitForIndex(knowledgeId, 10_000);
    expect(getContent(knowledgeId)!.title).to.equal("Moby-Dick");
    expect(getContent(knowledgeId)!.author).to.equal("Herman Melville");
  });

  it("raw Gutenberg text: license stripped for indexing and verify chunks, metadata from the header", async () => {
    const create = stubKgLLM();
    const { knowledgeId } = await pocw.index(gutenbergText(), { asText: true });
    await pocw.waitForIndex(knowledgeId, 10_000);
    const row = getContent(knowledgeId)!;
    expect(row.title).to.equal("Moby-Dick; or The Whale");
    expect(row.author).to.equal("Herman Melville");
    const sent = create.getCalls().map(c => c.args[0].messages[1].content as string).join("\n");
    expect(sent).to.contain("Call me Ishmael");
    expect(sent).to.not.contain("Project Gutenberg");
    const { chunks } = await pocw.getContentChunks(knowledgeId);
    expect(chunks.join(" ")).to.not.contain("Project Gutenberg");
  });

  it("a whole book is indexed from ~40 sampled chunks into one capped graph", async () => {
    const create = stubKgLLM();
    const words = "whale sea ship captain harpoon voyage ocean sailor ".repeat(40_000); // ~2 M chars
    const { knowledgeId } = await pocw.index(words, { asText: true });
    await pocw.waitForIndex(knowledgeId, 10_000);
    expect(create.callCount).to.equal(40);
    expect(getContent(knowledgeId)!.chunk_count).to.be.above(550);
  });
});

describe("Content store — author column", () => {
  let dir: string;
  afterEach(() => {
    closeContentStore();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("adds `author` to an existing database idempotently and keeps listings small", async () => {
    closeContentStore();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pocw-mig-"));
    const file = path.join(dir, "old.db");
    const old = new Database(file);
    old.exec(`CREATE TABLE content_index (knowledge_id TEXT PRIMARY KEY, content_type TEXT NOT NULL, source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', error TEXT, content_id INTEGER, content_hash TEXT, chunk_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), indexed_at TEXT, usage_count INTEGER DEFAULT 0, last_used_at TEXT)`);
    old.prepare("INSERT INTO content_index (knowledge_id, content_type, source) VALUES ('k1', 'url', 'https://x.example/book.epub')").run();
    old.close();

    for (let i = 0; i < 2; i++) { // second open must not fail (idempotent)
      initContentStore(file);
      closeContentStore();
    }
    initContentStore(file);
    expect(getContent("k1")!.author).to.equal(null);
    await updateMetadata("k1", "Title", "desc", "Jane Austen");
    expect(getContent("k1")!.author).to.equal("Jane Austen");
    await updateMetadata("k1", "Other title", "desc"); // author omitted → unchanged
    expect(getContent("k1")!.author).to.equal("Jane Austen");

    const book = "word ".repeat(200_000);
    await insertContent("k2", "raw_text", book, 2);
    const listed = listContent().rows.find(r => r.knowledge_id === "k2")!;
    expect(listed.source.length).to.equal(301);         // only a prefix is loaded for listings
    expect(getContent("k2")!.source).to.equal(book);     // full text for indexing / re-parsing
  });
});
