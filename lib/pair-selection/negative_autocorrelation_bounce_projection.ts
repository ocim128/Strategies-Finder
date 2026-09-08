import type { PairSelectionRule } from "./types";

export const negative_autocorrelation_bounce_projection: PairSelectionRule = {
    key: "negative_autocorrelation_bounce_projection",
    name: "Negative Autocorrelation Bounce Projection",
    description: "Projects adverse 12-bar return through the magnitude of negative lag-1 autocorrelation.",
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
        sourceFiles: ["lib/pair-selection/negative_autocorrelation_bounce_projection.ts"],
    },
    score: (candidate) => {
        const ret12 = candidate.feat_fp_spread_log_return_b12_r1;
        const autocorrelation = candidate.feat_fp_dependence_return_acf_b48_l1_r1;
        if (ret12 === null || autocorrelation === null) return Number.NEGATIVE_INFINITY;
        const adverseRet12 = candidate.direction === "long" ? -ret12 : ret12;
        return adverseRet12 * Math.max(0, -autocorrelation);
    },
};
