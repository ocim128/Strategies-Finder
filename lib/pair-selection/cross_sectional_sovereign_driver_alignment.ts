import { memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const cross_sectional_sovereign_driver_alignment: PairSelectionRule = {
    key: "cross_sectional_sovereign_driver_alignment",
    name: "Cross Sectional Sovereign Driver Alignment",
    description: "Scales favorable-leg pool dominance by signal ATR percentage.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/cross_sectional_sovereign_driver_alignment.ts"],
    },
    score: (candidate, _event, _params, pool) => {
        const counts = memoByPool(pool, "symbol-pool-frequency", () => {
            const map = new Map<string, number>();
            for (const c of pool) {
                map.set(c.baseSymbol, (map.get(c.baseSymbol) || 0) + 1);
                map.set(c.quoteSymbol, (map.get(c.quoteSymbol) || 0) + 1);
            }
            return map;
        });
        const fav = candidate.direction === "long" ? candidate.baseSymbol : candidate.quoteSymbol;
        const adv = candidate.direction === "long" ? candidate.quoteSymbol : candidate.baseSymbol;
        const netDominance = (counts.get(fav) || 0) - (counts.get(adv) || 0);
        const atr = candidate.feat_atrPct;
        if (atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return netDominance * atr;
    },
};
