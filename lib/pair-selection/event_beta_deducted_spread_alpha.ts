import { memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const event_beta_deducted_spread_alpha: PairSelectionRule = {
    key: "event_beta_deducted_spread_alpha",
    name: "Event Beta Deducted Spread Alpha",
    description: "Ranks direction-aligned 20-bar return after subtracting the event-wide raw return mean.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: [
            "lib/pair-selection/event_beta_deducted_spread_alpha.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        if (pool.length < 2) return Number.NEGATIVE_INFINITY;
        const ret20 = candidate.feat_return20;
        if (ret20 === null) return Number.NEGATIVE_INFINITY;
        const eventMean = memoByPool(pool, "event-beta-raw-ret20-mean", () => {
            const values = pool
                .map((entry) => entry.feat_return20)
                .filter((value): value is number => value !== null && Number.isFinite(value));
            if (values.length === 0) return null;
            return values.reduce((sum, value) => sum + value, 0) / values.length;
        });
        if (eventMean === null) return Number.NEGATIVE_INFINITY;
        const sign = candidate.direction === "long" ? 1 : -1;
        return sign * (ret20 - eventMean);
    },
};
