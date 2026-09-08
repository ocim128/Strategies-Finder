import type { PairSelectionRule } from "./types";

export const directional_spread_efficiency: PairSelectionRule = {
    key: "directional_spread_efficiency",
    name: "Directional Spread Efficiency",
    description: "Scales direction-aligned 48-bar spread return by its Kaufman efficiency ratio.",
    defaultParams: { efficiencyWeight: 1.0 },
    paramLabels: { efficiencyWeight: "Exponent weighting applied to Kaufman efficiency ratio" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_efficiency_ratio_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/directional_spread_efficiency.ts"],
    },
    score: (candidate, _event, params) => {
        const spreadReturn = candidate.feat_fp_spread_log_return_b48_r1;
        const ret = candidate.direction === "long"
            ? spreadReturn
            : (spreadReturn === null ? null : -spreadReturn);
        const eff = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        if (ret === null || eff === null) return Number.NEGATIVE_INFINITY;
        return ret * Math.pow(eff, params.efficiencyWeight!);
    },
};
