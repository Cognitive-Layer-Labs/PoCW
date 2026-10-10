import { expect } from "chai";
import { parseKGPayload } from "../src/services/kg-builder";

describe("KG Builder", () => {
  describe("parseKGPayload()", () => {
    it("parses valid KG JSON with nodes and edges", () => {
      const payload = JSON.stringify({
        nodes: [
          { id: "bitcoin", label: "Bitcoin", bloomLevel: "Remember", importance: 9 },
          { id: "proof_of_work", label: "Proof of Work", bloomLevel: "Understand", importance: 8 },
          { id: "double_spending", label: "Double Spending", bloomLevel: "Analyze", importance: 7 }
        ],
        edges: [
          { source: "bitcoin", target: "proof_of_work", relationship: "uses" },
          { source: "proof_of_work", target: "double_spending", relationship: "prevents" }
        ]
      });

      const graph = parseKGPayload(123, payload);

      expect(graph.contentId).to.equal(123);
      expect(graph.nodes).to.have.length(3);
      expect(graph.edges).to.have.length(2);
      expect(graph.nodes[0].label).to.equal("Bitcoin");
      expect(graph.nodes[0].bloomLevel).to.equal("Remember");
      expect(graph.edges[1].relationship).to.equal("prevents");
    });

    it("handles nodes with 'name' instead of 'label'", () => {
      const payload = JSON.stringify({
        nodes: [{ id: "a", name: "Node A", bloomLevel: "Apply", importance: 5 }],
        edges: []
      });

      const graph = parseKGPayload(1, payload);
      expect(graph.nodes[0].label).to.equal("Node A");
    });

    it("defaults invalid bloom levels to 'Understand'", () => {
      const payload = JSON.stringify({
        nodes: [{ id: "a", label: "A", bloomLevel: "InvalidLevel", importance: 5 }],
        edges: []
      });

      const graph = parseKGPayload(1, payload);
      expect(graph.nodes[0].bloomLevel).to.equal("Understand");
    });

    it("clamps importance to [1, 10]", () => {
      const payload = JSON.stringify({
        nodes: [
          { id: "a", label: "A", bloomLevel: "Remember", importance: 0 },
          { id: "b", label: "B", bloomLevel: "Remember", importance: 15 }
        ],
        edges: []
      });

      const graph = parseKGPayload(1, payload);
      expect(graph.nodes[0].importance).to.equal(1);
      expect(graph.nodes[1].importance).to.equal(10);
    });

    it("filters edges with invalid node references", () => {
      const payload = JSON.stringify({
        nodes: [{ id: "a", label: "A", bloomLevel: "Remember", importance: 5 }],
        edges: [
          { source: "a", target: "nonexistent", relationship: "test" }
        ]
      });

      const graph = parseKGPayload(1, payload);
      expect(graph.edges).to.have.length(0);
    });

    it("handles 'relationships' key instead of 'edges'", () => {
      const payload = JSON.stringify({
        nodes: [
          { id: "a", label: "A", bloomLevel: "Remember", importance: 5 },
          { id: "b", label: "B", bloomLevel: "Remember", importance: 5 }
        ],
        relationships: [
          { source: "a", target: "b", type: "connects" }
        ]
      });

      const graph = parseKGPayload(1, payload);
      expect(graph.edges).to.have.length(1);
      expect(graph.edges[0].relationship).to.equal("connects");
    });

    it("handles 'from'/'to' instead of 'source'/'target'", () => {
      const payload = JSON.stringify({
        nodes: [
          { id: "x", label: "X", bloomLevel: "Apply", importance: 5 },
          { id: "y", label: "Y", bloomLevel: "Apply", importance: 5 }
        ],
        edges: [
          { from: "x", to: "y", relationship: "links" }
        ]
      });

      const graph = parseKGPayload(1, payload);
      expect(graph.edges[0].source).to.equal("x");
      expect(graph.edges[0].target).to.equal("y");
    });

    it("returns empty graph for invalid JSON", () => {
      const graph = parseKGPayload(1, "not json at all");
      expect(graph.nodes).to.have.length(0);
      expect(graph.edges).to.have.length(0);
    });

    it("returns empty graph for empty payload", () => {
      const graph = parseKGPayload(1, "{}");
      expect(graph.nodes).to.have.length(0);
      expect(graph.edges).to.have.length(0);
    });

    it("auto-generates node IDs if missing", () => {
      const payload = JSON.stringify({
        nodes: [{ label: "No ID Node", bloomLevel: "Remember", importance: 5 }],
        edges: []
      });

      const graph = parseKGPayload(1, payload);
      expect(graph.nodes[0].id).to.equal("concept_0");
    });
  });
});
