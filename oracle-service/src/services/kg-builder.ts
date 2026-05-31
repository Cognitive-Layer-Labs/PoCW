/**
 * Knowledge Graph Builder
 *
 * Extracts entities (concepts) and relationships from parsed content
 * using an LLM, producing a structured graph for KAQG question generation.
 */

import { readFileSync } from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { getOpenAIClient } from "./llm-client";

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

interface KGConfig {
  ["kg-model"]: string;
  ["kg-prompt"]: string;
}

const configPath = path.resolve(__dirname, "..", "..", "ai-config.yml");
const config = yaml.load(readFileSync(configPath, "utf8")) as KGConfig;

/**
 * Extract a knowledge graph from content text using the LLM.
 */
export async function extractKnowledgeGraph(
  contentId: number,
  contentText: string
): Promise<KnowledgeGraph> {
  const completion = await getOpenAIClient().chat.completions.create({
    model: config["kg-model"],
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: config["kg-prompt"]
      },
      {
        role: "user",
        content: `Content:\n${contentText}`
      }
    ]
  });

  const payload = completion.choices[0].message.content || "";
  return parseKGPayload(contentId, payload);
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
 * Parse LLM response into a KnowledgeGraph structure.
 */
export function parseKGPayload(contentId: number, payload: string): KnowledgeGraph {
  const validBloomLevels = new Set([
    "Remember", "Understand", "Apply", "Analyze", "Evaluate", "Create"
  ]);

  try {
    const parsed = JSON.parse(payload);

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

    return { contentId, nodes: normalizeImportance(nodes, edges), edges };
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
