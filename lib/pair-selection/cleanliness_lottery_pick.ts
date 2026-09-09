import type { PairSelectionRule } from "./types";
import { memoByPool } from "./rule-helpers";

function cleanTercileThreshold(pool: Parameters<PairSelectionRule["score"]>[3]): number | null {
    const values = pool
        .map((entry) => entry.feat_fp_spread_efficiency_ratio_b48_r1)
        .filter((value): value is number => value !== null && Number.isFinite(value))
        .sort((left, right) => right - left);
    if (values.length === 0) return null;
    const tercileCount = Math.max(1, Math.ceil(values.length / 3));
    return values[Math.min(tercileCount, values.length) - 1]!;
}

export const cleanliness_lottery_pick: PairSelectionRule = {
    key: "cleanliness_lottery_pick",
    name: "Cleanliness Lottery Pick",
    description: "Uses the shared deterministic tie-break inside the top efficiency tercile.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_efficiency_ratio_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/cleanliness_lottery_pick.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const efficiency = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        if (efficiency === null || !Number.isFinite(efficiency)) return 0;
        const threshold = memoByPool(pool, "cleanliness-lottery-pick-threshold", () => cleanTercileThreshold(pool));
        return threshold !== null && efficiency >= threshold ? 1 : 0;
    },
};
