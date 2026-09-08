import type { PairSelectionRule } from "./types";

export const volatility_clustering_scaled_momentum: PairSelectionRule = {
    key: "volatility_clustering_scaled_momentum",
    name: "Volatility Clustering Scaled Momentum",
    description: "Scales direction-aligned 48-bar return by absolute-return autocorrelation clustering.",
    defaultParams: { clusteringWeight: 1.0 },
    paramLabels: { clusteringWeight: "Sensitivity weight applied to absolute-return autocorrelation" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_volatility_abs_return_acf_b48_l1_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/volatility_clustering_scaled_momentum.ts"],
    },
    score: (candidate, _event, params) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        const absoluteReturnAcf = candidate.feat_fp_volatility_abs_return_acf_b48_l1_r1;
        if (ret48 === null || absoluteReturnAcf === null) return Number.NEGATIVE_INFINITY;
        const dirRet48 = candidate.direction === "long" ? ret48 : -ret48;
        return dirRet48 * (1 + params.clusteringWeight! * Math.max(0, absoluteReturnAcf));
    },
};
