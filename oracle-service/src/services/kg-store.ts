/**
 * Neo4j Knowledge Graph Store
 *
 * Persists and queries knowledge graphs extracted from content.
 * Supports difficulty-based concept retrieval for KAQG.
 */

import neo4j, { Driver, Session } from "neo4j-driver";
import { KGNode, KGEdge, KnowledgeGraph } from "./kg-builder";
import { difficultyToBloom } from "./irt-engine";

let driver: Driver | null = null;

/**
 * Initialize the Neo4j driver.
 */
export function initNeo4j(
  uri = process.env.NEO4J_URI || "bolt://localhost:7687",
  user = process.env.NEO4J_USER || "neo4j",
  password = process.env.NEO4J_PASSWORD || "pocw_dev_password"
): Driver {
  if (!driver) {
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }
  return driver;
}

/**
 * Close the Neo4j driver connection.
 */
export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

function getSession(): Session {
  if (!driver) initNeo4j();
  return driver!.session();
}

/**
 * Check if a knowledge graph already exists for a given contentId.
 */
export async function graphExists(contentId: number): Promise<boolean> {
  const session = getSession();
  try {
    const result = await session.run(
      "MATCH (c:Concept {contentId: $contentId}) RETURN count(c) AS cnt",
      { contentId }
    );
    const cnt = result.records[0]?.get("cnt")?.toNumber() ?? 0;
    return cnt > 0;
  } finally {
    await session.close();
  }
}

/**
 * Store a knowledge graph in Neo4j.
 * Creates :Concept nodes and relationship edges.
 */
export async function storeGraph(graph: KnowledgeGraph): Promise<void> {
  const session = getSession();
  try {
    // Create nodes
    for (const node of graph.nodes) {
      await session.run(
        `MERGE (c:Concept {id: $id, contentId: $contentId})
         SET c.label = $label,
             c.bloomLevel = $bloomLevel,
             c.importance = $importance`,
        {
          id: node.id,
          contentId: graph.contentId,
          label: node.label,
          bloomLevel: node.bloomLevel,
          importance: neo4j.int(node.importance)
        }
      );
    }

    // Create edges
    for (const edge of graph.edges) {
      await session.run(
        `MATCH (a:Concept {id: $source, contentId: $contentId})
         MATCH (b:Concept {id: $target, contentId: $contentId})
         MERGE (a)-[r:RELATES_TO {type: $relationship}]->(b)`,
        {
          source: edge.source,
          target: edge.target,
          contentId: graph.contentId,
          relationship: edge.relationship
        }
      );
    }
  } finally {
    await session.close();
  }
}

/**
 * Retrieve the full knowledge graph for a contentId.
 */
export async function getGraph(contentId: number): Promise<KnowledgeGraph> {
  const session = getSession();
  try {
    const nodesResult = await session.run(
      "MATCH (c:Concept {contentId: $contentId}) RETURN c",
      { contentId }
    );

    const nodes: KGNode[] = nodesResult.records.map(r => {
      const c = r.get("c").properties;
      return {
        id: c.id,
        label: c.label,
        bloomLevel: c.bloomLevel,
        importance: typeof c.importance === "object" ? c.importance.toNumber() : Number(c.importance)
      };
    });

    const edgesResult = await session.run(
      `MATCH (a:Concept {contentId: $contentId})-[r:RELATES_TO]->(b:Concept {contentId: $contentId})
       RETURN a.id AS source, b.id AS target, r.type AS relationship`,
      { contentId }
    );

    const edges: KGEdge[] = edgesResult.records.map(r => ({
      source: r.get("source"),
      target: r.get("target"),
      relationship: r.get("relationship")
    }));

    return { contentId, nodes, edges };
  } finally {
    await session.close();
  }
}

/**
 * Get concepts matching a target IRT difficulty by mapping to Bloom's Taxonomy level.
 * Returns up to `limit` concepts at the target Bloom's level, ordered by importance.
 * Falls back to adjacent Bloom's levels if not enough concepts at the exact level.
 */
export async function getConceptsByDifficulty(
  contentId: number,
  targetDifficulty: number,
  limit = 3
): Promise<{ concepts: KGNode[]; subgraph: { nodes: KGNode[]; edges: KGEdge[] } }> {
  const targetBloom = difficultyToBloom(targetDifficulty);
  const bloomOrder = ["Remember", "Understand", "Apply", "Analyze", "Evaluate", "Create"];
  const targetIdx = bloomOrder.indexOf(targetBloom);

  // Try exact match first, then expand to adjacent levels
  const levelsToTry = [targetBloom];
  if (targetIdx > 0) levelsToTry.push(bloomOrder[targetIdx - 1]);
  if (targetIdx < bloomOrder.length - 1) levelsToTry.push(bloomOrder[targetIdx + 1]);

  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (c:Concept {contentId: $contentId})
       WHERE c.bloomLevel IN $levels
       RETURN c
       ORDER BY
         CASE c.bloomLevel WHEN $primary THEN 0 ELSE 1 END,
         c.importance DESC
       LIMIT $limit`,
      {
        contentId,
        levels: levelsToTry,
        primary: targetBloom,
        limit: neo4j.int(limit)
      }
    );

    const concepts: KGNode[] = result.records.map(r => {
      const c = r.get("c").properties;
      return {
        id: c.id,
        label: c.label,
        bloomLevel: c.bloomLevel,
        importance: typeof c.importance === "object" ? c.importance.toNumber() : Number(c.importance)
      };
    });

    // Get the subgraph around these concepts (1-hop neighbors)
    const conceptIds = concepts.map(c => c.id);
    let subgraphNodes = [...concepts];
    let subgraphEdges: KGEdge[] = [];

    if (conceptIds.length > 0) {
      const subResult = await session.run(
        `MATCH (a:Concept {contentId: $contentId})-[r:RELATES_TO]-(b:Concept {contentId: $contentId})
         WHERE a.id IN $ids
         RETURN DISTINCT a.id AS aId, b.id AS bId, b.label AS bLabel,
                b.bloomLevel AS bBloom, b.importance AS bImp,
                r.type AS rel,
                startNode(r) = a AS isOutgoing`,
        { contentId, ids: conceptIds }
      );

      const extraNodeIds = new Set(conceptIds);
      for (const r of subResult.records) {
        const bId = r.get("bId");
        if (!extraNodeIds.has(bId)) {
          extraNodeIds.add(bId);
          const bImp = r.get("bImp");
          subgraphNodes.push({
            id: bId,
            label: r.get("bLabel"),
            bloomLevel: r.get("bBloom"),
            importance: typeof bImp === "object" ? bImp.toNumber() : Number(bImp)
          });
        }
        const isOut = r.get("isOutgoing");
        subgraphEdges.push({
          source: isOut ? r.get("aId") : bId,
          target: isOut ? bId : r.get("aId"),
          relationship: r.get("rel")
        });
      }
    }

    return { concepts, subgraph: { nodes: subgraphNodes, edges: subgraphEdges } };
  } finally {
    await session.close();
  }
}

/** For testing: override the driver */
export function __setDriverForTest(d: Driver): void {
  driver = d;
}
