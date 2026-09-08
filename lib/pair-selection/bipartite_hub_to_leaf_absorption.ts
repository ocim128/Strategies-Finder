import { memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const bipartite_hub_to_leaf_absorption: PairSelectionRule = {
    key: "bipartite_hub_to_leaf_absorption",
    name: "Bipartite Hub to Leaf Absorption",
    description: "Scales normalized pair-leg degree disparity by signal ATR percentage.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/bipartite_hub_to_leaf_absorption.ts"],
    },
    score: (candidate, _event, _params, pool) => {
        const counts = memoByPool(pool, "sym-deg", () => {
            const map = new Map<string, number>();
            for (const c of pool) {
                map.set(c.baseSymbol, (map.get(c.baseSymbol) || 0) + 1);
                map.set(c.quoteSymbol, (map.get(c.quoteSymbol) || 0) + 1);
            }
            return map;
        });
        const b = counts.get(candidate.baseSymbol) || 1;
        const q = counts.get(candidate.quoteSymbol) || 1;
        const atr = candidate.feat_atrPct;
        if (atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return (Math.abs(b - q) / (b + q)) * atr;
    },
};
