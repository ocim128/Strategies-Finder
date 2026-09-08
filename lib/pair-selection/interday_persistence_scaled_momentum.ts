import type { PairSelectionRule } from "./types";

export const interday_persistence_scaled_momentum: PairSelectionRule = {
    key: "interday_persistence_scaled_momentum",
    name: "Interday Persistence Scaled Momentum",
    description: "Scales direction-aligned 48-bar spread momentum by 240-bar lag-4 autocorrelation.",
    defaultParams: { persistenceWeight: 2.0 },
    paramLabels: { persistenceWeight: "Sensitivity weight applied to 240-bar lag-4 autocorrelation" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_dependence_return_acf_b240_l4_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/interday_persistence_scaled_momentum.ts"],
    },
    score: (candidate, _event, params) => {
        const spreadReturn = candidate.feat_fp_spread_log_return_b48_r1;
        const ret = candidate.direction === "long"
            ? spreadReturn
            : (spreadReturn === null ? null : -spreadReturn);
        const acf4 = candidate.feat_fp_dependence_return_acf_b240_l4_r1;
        if (ret === null || acf4 === null) return Number.NEGATIVE_INFINITY;
        return ret * (1 + acf4 * params.persistenceWeight!);
    },
};
