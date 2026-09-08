import { memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const event_breadth_directional_concordance: PairSelectionRule = {
    key: "event_breadth_directional_concordance",
    name: "Event Breadth Directional Concordance",
    description: "Scales direction-aligned 48-bar return by same-direction event fire breadth.",
    defaultParams: { breadthExponent: 1.0 },
    paramLabels: { breadthExponent: "Exponent on same-direction fire fraction in the event pool" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/event_breadth_directional_concordance.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        if (pool.length < 2) return Number.NEGATIVE_INFINITY;
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        if (ret48 === null) return Number.NEGATIVE_INFINITY;
        const longFraction = memoByPool(pool, "event-breadth-long-fraction", () =>
            pool.filter((entry) => entry.direction === "long").length / pool.length);
        const directionalBreadth = candidate.direction === "long" ? longFraction : 1 - longFraction;
        const directionalReturn = candidate.direction === "long" ? ret48 : -ret48;
        return directionalReturn * Math.pow(directionalBreadth, params.breadthExponent!);
    },
};
