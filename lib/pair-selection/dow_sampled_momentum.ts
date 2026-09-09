import type { PairSelectionRule } from "./types";

export const dow_sampled_momentum: PairSelectionRule = {
    key: "dow_sampled_momentum",
    name: "Dow Sampled Momentum",
    description: "Ranks the direction-adjusted mean increment sampled on the decision bar's weekday.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/dow_sampled_momentum.ts"],
    },
    score: (candidate) => {
        const sampledDrift = candidate.feat_fp_spread_dow_sampled_drift_b48_r1;
        return sampledDrift === null || !Number.isFinite(sampledDrift)
            ? Number.NEGATIVE_INFINITY
            : sampledDrift;
    },
};
