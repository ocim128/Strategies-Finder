import { memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const cross_sectional_leg_flow_consensus: PairSelectionRule = {
    key: "cross_sectional_leg_flow_consensus",
    name: "Cross Sectional Leg Flow Consensus",
    description: "Ranks pairs by aggregate directional buy and sell votes for their two legs.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/cross_sectional_leg_flow_consensus.ts"],
    },
    score: (candidate, _event, _params, pool) => {
        const consensus = memoByPool(pool, "leg-consensus", () => {
            const buys = new Map<string, number>();
            const sells = new Map<string, number>();
            for (const c of pool) {
                if (c.direction === "long") {
                    buys.set(c.baseSymbol, (buys.get(c.baseSymbol) || 0) + 1);
                    sells.set(c.quoteSymbol, (sells.get(c.quoteSymbol) || 0) + 1);
                } else {
                    sells.set(c.baseSymbol, (sells.get(c.baseSymbol) || 0) + 1);
                    buys.set(c.quoteSymbol, (buys.get(c.quoteSymbol) || 0) + 1);
                }
            }
            return { buys, sells };
        });
        const bNet = (consensus.buys.get(candidate.baseSymbol) || 0)
            - (consensus.sells.get(candidate.baseSymbol) || 0);
        const qNet = (consensus.sells.get(candidate.quoteSymbol) || 0)
            - (consensus.buys.get(candidate.quoteSymbol) || 0);
        return candidate.direction === "long" ? bNet + qNet : -bNet - qNet;
    },
};
