import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

interface DirectionShares {
    long: number;
    short: number;
}

export const minority_direction_momentum_weight: PairSelectionRule = {
    key: "minority_direction_momentum_weight",
    name: "Minority Direction Momentum Weight",
    description: "Weights directional 48-bar momentum by the candidate's rarity within the event direction mix.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/minority_direction_momentum_weight.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null || pool.length === 0) return Number.NEGATIVE_INFINITY;
        const shares = memoByPool(pool, "minority-direction-momentum-weight-shares", (): DirectionShares => ({
            long: pool.filter((entry) => entry.direction === "long").length / pool.length,
            short: pool.filter((entry) => entry.direction === "short").length / pool.length,
        }));
        const sameDirectionShare = candidate.direction === "long" ? shares.long : shares.short;
        return return48 * (1 - sameDirectionShare);
    },
};
