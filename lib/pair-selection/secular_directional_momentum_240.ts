import type { PairSelectionRule } from "./types";

export const secular_directional_momentum_240: PairSelectionRule = {
    key: "secular_directional_momentum_240",
    name: "Secular Directional Momentum 240",
    description: "Ranks 240-bar spread return aligned with the signal direction.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b240_r1"],
        },
        sourceFiles: ["lib/pair-selection/secular_directional_momentum_240.ts"],
    },
    score: (candidate) => {
        const ret240 = candidate.feat_fp_spread_log_return_b240_r1;
        if (ret240 === null || !Number.isFinite(ret240)) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? ret240 : -ret240;
    },
};
