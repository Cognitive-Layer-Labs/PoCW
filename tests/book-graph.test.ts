import { expect } from "chai";
import {
  kgSampleIndices, canonicalLabel, mergeKnowledgeGraphs, buildKnowledgeGraph, KnowledgeGraph,
  KG_MAX_SAMPLED_CHUNKS, KG_MAX_NODES, KG_CONCURRENCY,
} from "../src/services/kg-builder";
import { chunksMentioning, selectChunkIndex } from "../src/services/session-manager";
import { chunkText } from "../src/services/parser";
import { LRUCache } from "../src/sdk/index";

const graph = (nodes: Array<[string, string, number, string?]>, edges: Array<[string, string, string?]> = []): KnowledgeGraph => ({
  contentId: 1,
  nodes: nodes.map(([id, label, importance, bloomLevel]) => ({ id, label, importance, bloomLevel: bloomLevel ?? "Understand" })),
  edges: edges.map(([source, target, relationship]) => ({ source, target, relationship: relationship ?? "relates to" })),
});

describe("Whole-book knowledge graphs", () => {
  describe("chunk sampling", () => {
    it("uses every chunk of short texts", () => {
      expect(kgSampleIndices(1)).to.deep.equal([0]);
      expect(kgSampleIndices(15)).to.deep.equal(Array.from({ length: 15 }, (_, i) => i));
    });

    it("scales with √length up to 40 calls, spread over the whole text", () => {
      expect(kgSampleIndices(100)).to.have.length(20);
      // Moby-Dick ≈ 1.2 M chars ≈ 350 chunks of 4 000 chars (3 500 step)
      const moby = chunkText("x".repeat(1_200_000)).length;
      expect(moby).to.be.within(340, 350);
      expect(kgSampleIndices(moby)).to.have.length(37);
      for (const n of [400, 1150, 5000]) {
        const idx = kgSampleIndices(n);
        expect(idx, String(n)).to.have.length(KG_MAX_SAMPLED_CHUNKS);
        expect(idx[0]).to.be.above(0);                      // skips the very first chunk (front matter)
        expect(idx[idx.length - 1]).to.be.below(n - 1);     // …and the very last
        expect(idx[idx.length - 1]).to.be.at.least(n * 0.95);
        for (let i = 1; i < idx.length; i++) expect(idx[i]).to.be.above(idx[i - 1]);
      }
    });
  });

  describe("merging", () => {
    it("canonical labels ignore case, accents, articles, possessives, plurals and parentheticals", () => {
      expect(canonicalLabel("The White Whale")).to.equal(canonicalLabel("white whales"));
      expect(canonicalLabel("Ahab's")).to.equal("ahab");
      expect(canonicalLabel("Pequod (ship)")).to.equal("pequod");
      expect(canonicalLabel("Café Society")).to.equal(canonicalLabel("cafe society"));
      expect(canonicalLabel("Stories")).to.equal("story");
      expect(canonicalLabel("Class")).to.equal("class");
      expect(canonicalLabel("Война и мир")).to.equal(canonicalLabel("война и мир"));
    });

    it("merges the same concept across chunks into one node with remapped, de-duplicated edges", () => {
      const merged = mergeKnowledgeGraphs(1, [
        graph([["ahab", "Captain Ahab", 9, "Analyze"], ["whale", "Moby Dick", 10]], [["ahab", "whale", "hunts"]]),
        graph([["c1", "captain ahab", 8, "Understand"], ["c2", "Moby-Dick", 9], ["c3", "Ishmael", 7]],
          [["c1", "c2", "hunts"], ["c3", "c1", "serves under"], ["c1", "c1", "self"]]),
        graph([["x", "CAPTAIN AHAB", 7, "Understand"]]),
      ]);
      expect(merged.nodes.map(n => n.label).sort()).to.deep.equal(["Captain Ahab", "Ishmael", "Moby Dick"]);
      const ahab = merged.nodes.find(n => n.label === "Captain Ahab")!;
      expect(ahab.id).to.equal("captain_ahab");
      expect(ahab.bloomLevel).to.equal("Understand");           // most frequent
      expect(merged.edges).to.have.length(2);                  // "hunts" de-duplicated, self-loop dropped
      expect(merged.edges).to.deep.include({ source: "captain_ahab", target: "moby_dick", relationship: "hunts" });
      for (const n of merged.nodes) expect(n.importance).to.be.within(0, 1);
      // Recurring + important concepts rank highest
      const byImp = [...merged.nodes].sort((a, b) => b.importance - a.importance).map(n => n.label);
      expect(byImp[0]).to.equal("Captain Ahab");
      expect(byImp[2]).to.equal("Ishmael");
    });

    it(`caps the graph at ${KG_MAX_NODES} nodes by score and keeps only edges between kept nodes`, () => {
      const graphs = Array.from({ length: 30 }, (_, g) => graph(
        Array.from({ length: 10 }, (_, i) => [`n${i}`, `Concept ${g * 10 + i}`, 1 + ((g * 10 + i) % 10)] as [string, string, number]),
        Array.from({ length: 9 }, (_, i) => [`n${i}`, `n${i + 1}`] as [string, string]),
      ));
      // a hub concept present in every chunk
      graphs.forEach(g => g.nodes.push({ id: "hub", label: "The Hub", importance: 5, bloomLevel: "Apply" }));
      const merged = mergeKnowledgeGraphs(1, graphs);
      expect(merged.nodes).to.have.length(KG_MAX_NODES);
      expect(merged.nodes.map(n => n.label)).to.include("The Hub");
      const ids = new Set(merged.nodes.map(n => n.id));
      expect(ids.size).to.equal(KG_MAX_NODES);
      for (const e of merged.edges) {
        expect(ids.has(e.source) && ids.has(e.target), `${e.source}->${e.target}`).to.equal(true);
      }
    });
  });

  describe("buildKnowledgeGraph", () => {
    const chunks = Array.from({ length: 400 }, (_, i) => `chunk ${i}`);

    it(`samples ${KG_MAX_SAMPLED_CHUNKS} chunks of a long book with at most ${KG_CONCURRENCY} LLM calls in flight`, async () => {
      let inFlight = 0;
      let peak = 0;
      const seen: string[] = [];
      const merged = await buildKnowledgeGraph(1, chunks, {
        extract: async (_id, chunk) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          seen.push(chunk);
          await new Promise(r => setTimeout(r, 2));
          inFlight--;
          return graph([["a", "Shared Concept", 8], ["b", `Local ${chunk}`, 3]], [["a", "b"]]);
        },
      });
      expect(seen).to.have.length(KG_MAX_SAMPLED_CHUNKS);
      expect(peak).to.be.at.most(KG_CONCURRENCY);
      expect(peak).to.be.above(1);
      expect(merged.nodes.filter(n => n.label === "Shared Concept")).to.have.length(1);
      expect(merged.nodes.length).to.be.at.most(KG_MAX_NODES);
    });

    it("tolerates failing chunks (one retry each) and fails only when every chunk fails", async () => {
      let calls = 0;
      const flaky = await buildKnowledgeGraph(1, chunks.slice(0, 10), {
        extract: async (_id, chunk) => {
          calls++;
          if (chunk === "chunk 3") throw new Error("LLM down");
          return graph([["a", `Concept from ${chunk}`, 5]]);
        },
      });
      expect(calls).to.equal(11); // 10 chunks + 1 retry
      expect(flaky.nodes).to.have.length(9);

      try {
        await buildKnowledgeGraph(1, chunks.slice(0, 3), { extract: async () => { throw new Error("LLM down"); } });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.equal("LLM down");
      }
    });
  });

  describe("question chunks", () => {
    const book = [
      "Chapter 1. Ishmael goes to sea.",
      "Captain Ahab paces the deck of the Pequod.",
      "The whale is white. Ahab swears revenge.",
      "Queequeg and Ishmael share a bed at the inn.",
    ];

    it("finds the passages that mention a concept (full label, then all words, then single words)", () => {
      expect(chunksMentioning(book, "Captain Ahab")).to.deep.equal([1]);
      expect(chunksMentioning(book, "Ahab (captain)")).to.deep.equal([1, 2]);
      expect(chunksMentioning(book, "Ishmael and Queequeg")).to.deep.equal([3]);
      expect(chunksMentioning(book, "Ahab's obsession")).to.deep.equal([1, 2]);
      expect(chunksMentioning(book, "Ahab's revenge oath")).to.deep.equal([2]);        // longest matching word
      expect(chunksMentioning(book, "Nantucket whaling industry")).to.deep.equal([]);
      expect(chunksMentioning(book, "Starbuck")).to.deep.equal([]);
      expect(chunksMentioning(book, undefined)).to.deep.equal([]);
    });

    it("selects among candidate chunks, least used first, and anywhere when there are none", () => {
      const usage = [0, 5, 0, 0];
      for (let i = 0; i < 50; i++) expect([1, 2]).to.include(selectChunkIndex(usage, [1, 2]));
      const counts = [0, 0];
      for (let i = 0; i < 400; i++) counts[selectChunkIndex(usage, [1, 2]) === 2 ? 1 : 0]++;
      expect(counts[1]).to.be.above(counts[0] * 2); // weight 6 vs 1
      const any = new Set(Array.from({ length: 200 }, () => selectChunkIndex([0, 0, 0, 0], [])));
      expect(any.size).to.equal(4);
      expect(selectChunkIndex([0, 0], [7, -1])).to.be.within(0, 1); // invalid candidates ignored
    });
  });

  describe("content cache", () => {
    it("is bounded by total weight as well as entry count", () => {
      const cache = new LRUCache<string, string>(100, 10, v => v.length);
      cache.set("a", "aaaa");
      cache.set("b", "bbbb");
      expect(cache.weight).to.equal(8);
      cache.get("a");                 // a becomes most recently used
      cache.set("c", "cccc");         // 12 > 10 → evict LRU (b)
      expect(cache.get("b")).to.equal(undefined);
      expect(cache.get("a")).to.equal("aaaa");
      expect(cache.weight).to.equal(8);
      cache.set("huge", "x".repeat(50)); // larger than the budget: kept alone
      expect(cache.size).to.equal(1);
      expect(cache.get("huge")).to.have.length(50);
    });
  });
});
