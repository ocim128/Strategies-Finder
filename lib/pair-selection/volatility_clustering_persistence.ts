import type { PairSelectionRule } from "./types";

export const volatility_clustering_persistence: PairSelectionRule = {
    key: "volatility_clustering_persistence",
    name: "Volatility Clustering Persistence",
    description: "Ranks absolute-return lag-1 autocorrelation over the preceding 48 bars.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v1", columns: ["feat_fp_volatility_abs_return_acf_b48_l1_r1"] },
        sourceFiles: ["lib/pair-selection/volatility_clustering_persistence.ts"],
    },
    score: (candidate) => {
        const acf = candidate.feat_fp_volatility_abs_return_acf_b48_l1_r1;
        if (acf === null || !Number.isFinite(acf)) return Number.NEGATIVE_INFINITY;
        return acf;
    },
};
