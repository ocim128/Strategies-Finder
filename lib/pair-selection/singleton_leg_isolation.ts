import { memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const singleton_leg_isolation: PairSelectionRule = {
    key: "singleton_leg_isolation",
    name: "Singleton Leg Isolation",
    description: "Minimizes the least frequent leg occurrence in the same-event pool.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/singleton_leg_isolation.ts"],
    },
    score: (candidate, _event, _params, pool) => {
        const counts = memoByPool(pool, "sym-counts", () => {
            const map = new Map<string, number>();
            for (const c of pool) {
                map.set(c.baseSymbol, (map.get(c.baseSymbol) || 0) + 1);
                map.set(c.quoteSymbol, (map.get(c.quoteSymbol) || 0) + 1);
            }
            return map;
        });
        const minCount = Math.min(
            counts.get(candidate.baseSymbol) || 1,
            counts.get(candidate.quoteSymbol) || 1,
        );
        return -minCount;
    },
};
