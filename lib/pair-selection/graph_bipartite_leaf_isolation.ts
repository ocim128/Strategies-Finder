import { memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const graph_bipartite_leaf_isolation: PairSelectionRule = {
    key: "graph_bipartite_leaf_isolation",
    name: "Graph Bipartite Leaf Isolation",
    description: "Penalizes the product of each pair's same-event base and quote symbol degrees.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/graph_bipartite_leaf_isolation.ts"],
    },
    score: (candidate, _event, _params, pool) => {
        const counts = memoByPool(pool, "symbol-degree-counts", () => {
            const map = new Map<string, number>();
            for (const c of pool) {
                map.set(c.baseSymbol, (map.get(c.baseSymbol) || 0) + 1);
                map.set(c.quoteSymbol, (map.get(c.quoteSymbol) || 0) + 1);
            }
            return map;
        });
        const bDeg = counts.get(candidate.baseSymbol) || 1;
        const qDeg = counts.get(candidate.quoteSymbol) || 1;
        return -(bDeg * qDeg);
    },
};
