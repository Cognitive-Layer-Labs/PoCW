/**
 * Knowledge Graph Builder
 *
 * Extracts entities (concepts) and relationships from parsed content
 * using an LLM, producing a structured graph for KAQG question generation.
 */

import { chatCompletion, extractJSONObject } from "./llm-client";
import { modelSpec, promptFor } from "./ai-config";

export interface KGNode {
  id: string;
  label: string;
  bloomLevel: string;   // Remember | Understand | Apply | Analyze | Evaluate | Create
  importance: number;    // 1-10 scale
}

export interface KGEdge {
  source: string;
  target: string;
  relationship: string;
}

export interface KnowledgeGraph {
  contentId: number;
  nodes: KGNode[];
  edges: KGEdge[];
}

/** Output budget per extraction call (room for "low" reasoning plus a 10–20 concept graph). */
const KG_MAX_TOKENS = 8000;

/**
 * Extract a knowledge graph from content text using the LLM (importance normalised to [0, 1]).
 */
export async function extractKnowledgeGraph(
  contentId: number,
  contentText: string
): Promise<KnowledgeGraph> {
  const raw = await extractRawKnowledgeGraph(contentId, contentText);
  return { ...raw, nodes: normalizeImportance(raw.nodes, raw.edges) };
}

/**
 * Extract one chunk's graph with the LLM's raw importance (1–10) kept, for merging across chunks
 * (see buildKnowledgeGraph).
 */
export async function extractRawKnowledgeGraph(
  contentId: number,
  contentText: string
): Promise<KnowledgeGraph> {
  // Called once per chunk (no breaker/retry here): buildKnowledgeGraph retries a failed chunk once.
  const completion = await chatCompletion("kg", modelSpec("kg-model"), {
    temperature: 0,
    max_tokens: KG_MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: promptFor("kg-prompt")
      },
      {
        role: "user",
        content: `Content:\n${contentText}`
      }
    ]
  }, { resilient: false });

  const payload = completion.choices?.[0]?.message?.content || "";
  // No JSON at all (truncated / refused): fail so the chunk is retried instead of silently empty.
  extractJSONObject(payload);
  return parseKGPayloadRaw(contentId, payload);
}

// Technology/domain terms that are often mis-labelled "Create" by the LLM because
// their name contains words like "generative", "building", "creating", "designing".
// These are knowledge topics — their Bloom level should reflect how hard they are to
// understand and apply, not what they sound like.
const TECH_CONCEPT_PATTERN =
  /\b(AI|ML|API|neural|deep|learning|intelligence|model|algorithm|framework|architecture|system|network|platform|service|library|pattern|module|component|cloud|protocol|pipeline|infrastructure|database|microservice|container|orchestrat|deployment|generative|modular|modulariz)\w*/i;

function sanitizeBloomLevel(node: KGNode): KGNode {
  if (node.bloomLevel !== "Create") return node;
  if (TECH_CONCEPT_PATTERN.test(node.label)) {
    return { ...node, bloomLevel: "Apply" };
  }
  return node;
}

const NOISE_PATTERNS = [
  /privacy\s*policy/i, /terms?\s*(of\s*)?(use|service)/i, /cookie/i,
  /disclaimer/i, /copyright/i, /all\s*rights\s*reserved/i,
  /financial\s*advice/i, /legal\s*advice/i, /medical\s*advice/i,
  /not\s*(financial|investment|legal|medical)/i,
  /wikipedia/i, /wikimedia/i,
  /navigation/i, /sidebar/i, /external\s*links/i,
  /retrieved\s*from/i, /categories?:/i, /see\s*also/i,
  /advertisement/i, /sponsored/i,
];

function isSubstantiveNode(node: KGNode): boolean {
  const label = node.label.toLowerCase();
  return !NOISE_PATTERNS.some(p => p.test(label));
}

/**
 * Parse LLM response into a KnowledgeGraph structure (importance normalised to [0, 1]).
 */
export function parseKGPayload(contentId: number, payload: string): KnowledgeGraph {
  const raw = parseKGPayloadRaw(contentId, payload);
  return { ...raw, nodes: normalizeImportance(raw.nodes, raw.edges) };
}

/** parseKGPayload without the importance normalisation (raw LLM importance 1–10). */
export function parseKGPayloadRaw(contentId: number, payload: string): KnowledgeGraph {
  const validBloomLevels = new Set([
    "Remember", "Understand", "Apply", "Analyze", "Evaluate", "Create"
  ]);

  try {
    const parsed = extractJSONObject(payload) as Record<string, any>;

    const nodes: KGNode[] = (parsed.nodes || [])
      .map((n: any, i: number) => ({
        id: String(n.id || `concept_${i}`),
        label: String(n.label || n.name || `Concept ${i}`),
        bloomLevel: validBloomLevels.has(n.bloomLevel) ? n.bloomLevel : "Understand",
        importance: Math.max(1, Math.min(10, n.importance != null ? Number(n.importance) : 5))
      }))
      .map(sanitizeBloomLevel)
      .filter(isSubstantiveNode);

    const nodeIds = new Set(nodes.map(n => n.id));

    const edges: KGEdge[] = (parsed.edges || parsed.relationships || [])
      .filter((e: any) =>
        nodeIds.has(String(e.source || e.from)) &&
        nodeIds.has(String(e.target || e.to))
      )
      .map((e: any) => ({
        source: String(e.source || e.from),
        target: String(e.target || e.to),
        relationship: String(e.relationship || e.type || "related_to")
      }));

    return { contentId, nodes, edges };
  } catch {
    return { contentId, nodes: [], edges: [] };
  }
}

function normalizeImportance(nodes: KGNode[], edges: KGEdge[]): KGNode[] {
  if (nodes.length === 0) return nodes;

  const degree: Record<string, number> = {};
  for (const n of nodes) degree[n.id] = 0;
  for (const e of edges) {
    if (e.source in degree) degree[e.source]++;
    if (e.target in degree) degree[e.target]++;
  }

  const sortedByImp = [...nodes].sort((a, b) => a.importance - b.importance);
  const impRank: Record<string, number> = {};
  sortedByImp.forEach((n, i) => { impRank[n.id] = i; });

  const sortedByDeg = [...nodes].sort((a, b) => (degree[a.id] || 0) - (degree[b.id] || 0));
  const degRank: Record<string, number> = {};
  sortedByDeg.forEach((n, i) => { degRank[n.id] = i; });

  const maxRank = nodes.length - 1;

  return nodes.map(n => {
    const normImp = maxRank === 0 ? 0.5 : impRank[n.id] / maxRank;
    const normDeg = maxRank === 0 ? 0.5 : degRank[n.id] / maxRank;
    const combined = 0.6 * normImp + 0.4 * normDeg;
    return { ...n, importance: Math.round(combined * 100) / 100 };
  });
}

// ─── Whole-document graphs (books) ───────────────────────────────────────────

/** Chunks sent to the LLM for short texts (all of them up to this many). */
export const KG_MIN_SAMPLED_CHUNKS = 15;
/** Upper bound on LLM extraction calls per document (long books). */
export const KG_MAX_SAMPLED_CHUNKS = 40;
/** Parallel LLM extraction calls. */
export const KG_CONCURRENCY = 4;
/** Nodes kept in the merged graph (a phone-sized graph). */
export const KG_MAX_NODES = 50;
/** Edges kept between the kept nodes (most frequently extracted first). */
export const KG_MAX_EDGES = 150;

/**
 * Which chunks to extract the graph from. Up to KG_MIN_SAMPLED_CHUNKS chunks: all of them.
 * Beyond that the budget grows with the square root of the length — 2·√n, capped at
 * KG_MAX_SAMPLED_CHUNKS (≈ 100 chunks / 350 k chars → 20 calls; ≥ 400 chunks / 1.4 M chars, e.g.
 * Moby-Dick → 40) — and one chunk is taken from the middle of each equal slice of the text, so
 * the sample spans the whole book and skips the very first/last chunk (front/back matter).
 */
export function kgSampleIndices(chunkCount: number): number[] {
  if (chunkCount <= KG_MIN_SAMPLED_CHUNKS) return Array.from({ length: chunkCount }, (_, i) => i);
  const budget = Math.min(KG_MAX_SAMPLED_CHUNKS, Math.max(KG_MIN_SAMPLED_CHUNKS, Math.round(2 * Math.sqrt(chunkCount))));
  const step = chunkCount / budget;
  return Array.from({ length: budget }, (_, i) => Math.min(chunkCount - 1, Math.floor((i + 0.5) * step)));
}

/**
 * Key used to merge concepts across chunks: case, accents, punctuation, parentheticals,
 * possessives, a leading article and a plural "s" on the last word are ignored
 * ("The Whale's", "whales", "Whale (animal)" → "whale").
 */
export function canonicalLabel(label: string): string {
  let s = label
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/['’]s\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(?:the|a|an)\s+/, "");
  s = s.replace(/(\p{L}{3,})ies$/u, "$1y").replace(/(\p{L}{3,}[^s\W])s$/u, "$1");
  return s;
}

const BLOOM_ORDER = ["Remember", "Understand", "Apply", "Analyze", "Evaluate", "Create"];

/**
 * Merge per-chunk graphs (raw LLM importance 1–10) into one coherent graph:
 *   - concepts with the same canonicalLabel() become one node (most frequent label wins, Bloom
 *     level = most frequent, ties → the lower level);
 *   - node score = sum of the importance it got in every chunk (central concepts recur);
 *   - the KG_MAX_NODES best-scored nodes are kept; edges between kept nodes are de-duplicated
 *     (self-loops dropped) and the KG_MAX_EDGES most frequent kept;
 *   - importance is re-normalised to [0, 1] over the merged graph (rank + degree, as per chunk).
 * Node ids are slugs of the canonical label, unique within the graph.
 */
export function mergeKnowledgeGraphs(
  contentId: number,
  graphs: KnowledgeGraph[],
  maxNodes = KG_MAX_NODES,
  maxEdges = KG_MAX_EDGES,
): KnowledgeGraph {
  interface Agg { key: string; score: number; count: number; labels: Map<string, number>; blooms: Map<string, number>; first: number }
  const nodes = new Map<string, Agg>();
  const edges = new Map<string, { source: string; target: string; count: number; rels: Map<string, number>; first: number }>();
  let order = 0;

  for (const g of graphs) {
    const keyOf = new Map<string, string>();
    for (const n of g.nodes) {
      const key = canonicalLabel(n.label) || canonicalLabel(n.id);
      if (!key) continue;
      keyOf.set(n.id, key);
      let a = nodes.get(key);
      if (!a) {
        a = { key, score: 0, count: 0, labels: new Map(), blooms: new Map(), first: order++ };
        nodes.set(key, a);
      }
      a.score += Number.isFinite(n.importance) ? n.importance : 5;
      a.count++;
      const label = n.label.trim();
      a.labels.set(label, (a.labels.get(label) ?? 0) + 1);
      a.blooms.set(n.bloomLevel, (a.blooms.get(n.bloomLevel) ?? 0) + 1);
    }
    for (const e of g.edges) {
      const s = keyOf.get(e.source);
      const t = keyOf.get(e.target);
      if (!s || !t || s === t) continue;
      const ek = `${s}\u0000${t}`;
      let agg = edges.get(ek);
      if (!agg) {
        agg = { source: s, target: t, count: 0, rels: new Map(), first: order++ };
        edges.set(ek, agg);
      }
      agg.count++;
      const rel = e.relationship.trim() || "related_to";
      agg.rels.set(rel, (agg.rels.get(rel) ?? 0) + 1);
    }
  }

  const mostFrequent = (m: Map<string, number>, tieBreak: (a: string, b: string) => number): string =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || tieBreak(a[0], b[0]))[0][0];

  const kept = [...nodes.values()]
    .sort((a, b) => b.score - a.score || b.count - a.count || a.first - b.first)
    .slice(0, maxNodes);

  const idOf = new Map<string, string>();
  const usedIds = new Set<string>();
  const mergedNodes: KGNode[] = kept.map(a => {
    const base = a.key.replace(/\s+/g, "_").slice(0, 80) || "concept";
    let id = base;
    for (let i = 2; usedIds.has(id); i++) id = `${base}_${i}`;
    usedIds.add(id);
    idOf.set(a.key, id);
    return {
      id,
      label: mostFrequent(a.labels, () => 0),
      bloomLevel: mostFrequent(a.blooms, (x, y) => BLOOM_ORDER.indexOf(x) - BLOOM_ORDER.indexOf(y)),
      importance: a.score,
    };
  });

  const mergedEdges: KGEdge[] = [...edges.values()]
    .filter(e => idOf.has(e.source) && idOf.has(e.target))
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, maxEdges)
    .map(e => ({
      source: idOf.get(e.source)!,
      target: idOf.get(e.target)!,
      relationship: mostFrequent(e.rels, () => 0),
    }));

  return { contentId, nodes: normalizeImportance(mergedNodes, mergedEdges), edges: mergedEdges };
}

/** Run `fn` over `items` with at most `limit` calls in flight; results in input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export interface BuildGraphOptions {
  /** Per-chunk extractor (defaults to the LLM; injectable for tests). */
  extract?: (contentId: number, chunk: string) => Promise<KnowledgeGraph>;
  concurrency?: number;
  maxNodes?: number;
}

/**
 * Build one merged knowledge graph for a whole document: sample chunks across the text
 * (kgSampleIndices), extract each with bounded concurrency (one retry per chunk), then merge
 * (mergeKnowledgeGraphs). Chunks that still fail are skipped; it throws only when every chunk failed.
 */
export async function buildKnowledgeGraph(
  contentId: number,
  chunks: string[],
  options: BuildGraphOptions = {},
): Promise<KnowledgeGraph> {
  const extract = options.extract ?? extractRawKnowledgeGraph;
  const sampled = kgSampleIndices(chunks.length).map(i => chunks[i]);
  const settled = await mapWithConcurrency(sampled, options.concurrency ?? KG_CONCURRENCY, async chunk => {
    try {
      return await extract(contentId, chunk);
    } catch {
      return extract(contentId, chunk); // one retry (transient LLM/network errors)
    }
  });
  const graphs = settled.filter((r): r is PromiseFulfilledResult<KnowledgeGraph> => r.status === "fulfilled").map(r => r.value);
  const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (graphs.length === 0 && failures.length > 0) throw failures[0].reason;
  if (failures.length > 0) {
    console.warn(`[kg-builder] ${failures.length}/${sampled.length} chunk extractions failed — merged the rest`);
  }
  return mergeKnowledgeGraphs(contentId, graphs, options.maxNodes ?? KG_MAX_NODES);
}
