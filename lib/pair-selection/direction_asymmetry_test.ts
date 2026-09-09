import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const direction_asymmetry_test: PairSelectionRule = {
    key: "direction_asymmetry_test",
    name: "Direction Asymmetry Test",
    description: "Follows directional momentum on short fires and fades it on long fires.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/direction_asymmetry_test.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "short" ? return48 : -return48;
    },
};
