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
      }));

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
