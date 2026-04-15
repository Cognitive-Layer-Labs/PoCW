/**
 * FalkorDB Knowledge Graph Store
 *
 * Persists and queries knowledge graphs extracted from content.
 * Supports difficulty-based concept retrieval for KAQG.
 *
 * Uses FalkorDB (Redis-based graph database) with openCypher queries.
 */

import { FalkorDB, Graph } from "falkordb";
import { KGNode, KGEdge, KnowledgeGraph } from "./kg-builder";
import { difficultyToBloom } from "./irt-engine";

/* eslint-disable @typescript-eslint/no-explicit-any */
type R = Record<string, any>;

let db: FalkorDB | null = null;
let graph: Graph | null = null;

/** WS4: When false, all KG operations become no-ops returning degraded results. */
let falkorAvailable = true;

/** Returns true if FalkorDB is currently connected. */
export function isFalkorAvailable(): boolean {
  return falkorAvailable;
}

/**
 * Initialize the FalkorDB connection and select the graph.
 */
export async function initFalkorDB(
  host = process.env.FALKORDB_HOST || "localhost",
  port = parseInt(process.env.FALKORDB_PORT || "6379"),
  password?: string,
  graphName = process.env.FALKORDB_GRAPH || "pocw"
): Promise<void> {
  if (!db) {
    const resolvedPassword = password || process.env.FALKORDB_PASSWORD;
    try {
      db = await FalkorDB.connect({
        socket: { host, port },
        ...(resolvedPassword ? { password: resolvedPassword } : {})
      });
      graph = db.selectGraph(graphName);
      falkorAvailable = true;
    } catch (err) {
      console.warn(
        "[kg-store] FalkorDB connection failed — KG extraction will be skipped.",
        err instanceof Error ? err.message : err
      );
      falkorAvailable = false;
      db = null;
      graph = null;
      startFalkorReconnect(host, port, resolvedPassword, graphName);
    }
  }
}

function startFalkorReconnect(
  host: string,
  port: number,
  password: string | undefined,
  graphName: string
): void {
  const interval = setInterval(async () => {
    try {
      const resolvedPassword = password || process.env.FALKORDB_PASSWORD;
      db = await FalkorDB.connect({
        socket: { host, port },
        ...(resolvedPassword ? { password: resolvedPassword } : {})
      });
      graph = db.selectGraph(graphName);
      falkorAvailable = true;
      clearInterval(interval);
      console.log("[kg-store] FalkorDB reconnected");
    } catch {
      // keep trying
    }
  }, 30_000);
  interval.unref();
}

/**
 * Close the FalkorDB connection.
 */
export async function closeFalkorDB(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
    graph = null;
  }
}

/** Get the graph instance, auto-initializing if needed. */
async function getGraph(): Promise<Graph> {
  if (!graph) await initFalkorDB();
  return graph!;
}

/**
 * Check if a knowledge graph already exists for a given contentId.
 */
export async function graphExists(contentId: number): Promise<boolean> {
  if (!falkorAvailable) return false;
  try {
    const g = await getGraph();
    const { data } = await g.query<R>(
      "MATCH (c:Concept {contentId: $contentId}) RETURN count(c) AS cnt",
      { params: { contentId } }
    );
    return ((data ?? [])[0]?.cnt ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Store a knowledge graph in FalkorDB.
 * Creates :Concept nodes and relationship edges.
 */
export async function storeGraph(kg: KnowledgeGraph): Promise<void> {
  if (!falkorAvailable) {
    console.warn("[kg-store] storeGraph skipped — FalkorDB unavailable");
    return;
  }
  const g = await getGraph();

  for (const node of kg.nodes) {
    await g.query(
      `MERGE (c:Concept {id: $id, contentId: $contentId})
       SET c.label = $label,
           c.bloomLevel = $bloomLevel,
           c.importance = $importance`,
      {
        params: {
          id: node.id,
          contentId: kg.contentId,
          label: node.label,
          bloomLevel: node.bloomLevel,
          importance: node.importance
        }
      }
    );
  }

  for (const edge of kg.edges) {
    await g.query(
      `MATCH (a:Concept {id: $source, contentId: $contentId})
       MATCH (b:Concept {id: $target, contentId: $contentId})
       MERGE (a)-[r:RELATES_TO {type: $relationship}]->(b)`,
      {
        params: {
          source: edge.source,
          target: edge.target,
          contentId: kg.contentId,
          relationship: edge.relationship
        }
      }
    );
  }
}

/**
 * Retrieve the full knowledge graph for a contentId.
 */
export async function getFullGraph(contentId: number): Promise<KnowledgeGraph> {
  const g = await getGraph();

  const nodesResult = await g.query<R>(
    "MATCH (c:Concept {contentId: $contentId}) RETURN c",
    { params: { contentId } }
  );

  const nodes: KGNode[] = (nodesResult.data ?? []).map((row) => {
    const c = row.c.properties;
    return {
      id: c.id,
      label: c.label,
      bloomLevel: c.bloomLevel,
      importance: c.importance
    };
  });

  const edgesResult = await g.query<R>(
    `MATCH (a:Concept {contentId: $contentId})-[r:RELATES_TO]->(b:Concept {contentId: $contentId})
     RETURN a.id AS source, b.id AS target, r.type AS relationship`,
    { params: { contentId } }
  );

  const edges: KGEdge[] = (edgesResult.data ?? []).map((row) => ({
    source: row.source,
    target: row.target,
    relationship: row.relationship
  }));

  return { contentId, nodes, edges };
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
): Promise<{ concepts: KGNode[]; subgraph: { nodes: KGNode[]; edges: KGEdge[] }; degraded?: boolean }> {
  if (_getConceptsByDifficultyOverride) {
    return _getConceptsByDifficultyOverride(contentId, targetDifficulty, limit);
  }
  if (!falkorAvailable) {
    return { concepts: [], subgraph: { nodes: [], edges: [] }, degraded: true };
  }
  const targetBloom = difficultyToBloom(targetDifficulty);
  const bloomOrder = ["Remember", "Understand", "Apply", "Analyze", "Evaluate", "Create"];
  const targetIdx = bloomOrder.indexOf(targetBloom);

  const levelsToTry = [targetBloom];
  if (targetIdx > 0) levelsToTry.push(bloomOrder[targetIdx - 1]);
  if (targetIdx < bloomOrder.length - 1) levelsToTry.push(bloomOrder[targetIdx + 1]);

  const g = await getGraph();

  const result = await g.query<R>(
    `MATCH (c:Concept {contentId: $contentId})
     WHERE c.bloomLevel IN $levels
     RETURN c
     ORDER BY
       CASE c.bloomLevel WHEN $primary THEN 0 ELSE 1 END,
       c.importance DESC
     LIMIT $limit`,
    {
      params: {
        contentId,
        levels: levelsToTry,
        primary: targetBloom,
        limit
      }
    }
  );

  const concepts: KGNode[] = (result.data ?? []).map((row) => {
    const c = row.c.properties;
    return {
      id: c.id,
      label: c.label,
      bloomLevel: c.bloomLevel,
      importance: c.importance
    };
  });

  // Get the subgraph around these concepts (1-hop neighbors)
  const conceptIds = concepts.map(c => c.id);
  let subgraphNodes = [...concepts];
  let subgraphEdges: KGEdge[] = [];

  if (conceptIds.length > 0) {
    // Outgoing edges from target concepts
    const outResult = await g.query<R>(
      `MATCH (a:Concept {contentId: $contentId})-[r:RELATES_TO]->(b:Concept {contentId: $contentId})
       WHERE a.id IN $ids
       RETURN DISTINCT a.id AS aId, b.id AS bId, b.label AS bLabel,
              b.bloomLevel AS bBloom, b.importance AS bImp,
              r.type AS rel`,
      { params: { contentId, ids: conceptIds } }
    );

    // Incoming edges to target concepts
    const inResult = await g.query<R>(
      `MATCH (b:Concept {contentId: $contentId})-[r:RELATES_TO]->(a:Concept {contentId: $contentId})
       WHERE a.id IN $ids
       RETURN DISTINCT a.id AS aId, b.id AS bId, b.label AS bLabel,
              b.bloomLevel AS bBloom, b.importance AS bImp,
              r.type AS rel`,
      { params: { contentId, ids: conceptIds } }
    );

    const extraNodeIds = new Set(conceptIds);

    // Process outgoing (a → b)
    for (const row of outResult.data ?? []) {
      if (!extraNodeIds.has(row.bId)) {
        extraNodeIds.add(row.bId);
        subgraphNodes.push({
          id: row.bId,
          label: row.bLabel,
          bloomLevel: row.bBloom,
          importance: row.bImp
        });
      }
      subgraphEdges.push({
        source: row.aId,
        target: row.bId,
        relationship: row.rel
      });
    }

    // Process incoming (b → a)
    for (const row of inResult.data ?? []) {
      if (!extraNodeIds.has(row.bId)) {
        extraNodeIds.add(row.bId);
        subgraphNodes.push({
          id: row.bId,
          label: row.bLabel,
          bloomLevel: row.bBloom,
          importance: row.bImp
        });
      }
      subgraphEdges.push({
        source: row.bId,
        target: row.aId,
        relationship: row.rel
      });
    }
  }

  return { concepts, subgraph: { nodes: subgraphNodes, edges: subgraphEdges } };
}

/** For testing: override the graph instance */
export function __setGraphForTest(g: Graph): void {
  graph = g;
}

/** For testing: override getConceptsByDifficulty */
let _getConceptsByDifficultyOverride: typeof getConceptsByDifficulty | null = null;

export function __setGetConceptsByDifficultyForTest(
  fn: typeof getConceptsByDifficulty | null
): void {
  _getConceptsByDifficultyOverride = fn;
}
