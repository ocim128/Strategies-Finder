import type { PairSelectionRule } from "./types";

export const econometric_forward_return_projection: PairSelectionRule = {
    key: "econometric_forward_return_projection",
    name: "Econometric Forward Return Projection",
    description: "Projects direction-aligned 12-bar return through 48-bar lag-1 autocorrelation.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_dependence_return_acf_b48_l1_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/econometric_forward_return_projection.ts"],
    },
    score: (candidate) => {
        const ret12 = candidate.feat_fp_spread_log_return_b12_r1;
        const autocorrelation = candidate.feat_fp_dependence_return_acf_b48_l1_r1;
        if (ret12 === null || autocorrelation === null) return Number.NEGATIVE_INFINITY;
        const directionalRet12 = candidate.direction === "long" ? ret12 : -ret12;
        return directionalRet12 * autocorrelation;
    },
};
