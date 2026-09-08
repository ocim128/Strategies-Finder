import type { PairSelectionRule } from "./types";

export const multi_horizon_directional_concordance: PairSelectionRule = {
    key: "multi_horizon_directional_concordance",
    name: "Multi-Horizon Directional Concordance",
    description: "Sums direction-aligned spread returns across 12, 48, and 240 bars.",
    defaultParams: { secularWeight: 0.5 },
    paramLabels: { secularWeight: "Weighting applied to the long-term 240-bar spread return" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_log_return_b240_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/multi_horizon_directional_concordance.ts"],
    },
    score: (candidate, _event, params) => {
        const r12 = candidate.feat_fp_spread_log_return_b12_r1;
        const r48 = candidate.feat_fp_spread_log_return_b48_r1;
        const r240 = candidate.feat_fp_spread_log_return_b240_r1;
        if (r12 === null || r48 === null || r240 === null) return Number.NEGATIVE_INFINITY;
        const sign = candidate.direction === "long" ? 1 : -1;
        return sign * (r12 + r48 + r240 * params.secularWeight!);
    },
};
