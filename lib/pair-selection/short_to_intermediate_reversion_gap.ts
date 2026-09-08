import type { PairSelectionRule } from "./types";

export const short_to_intermediate_reversion_gap: PairSelectionRule = {
    key: "short_to_intermediate_reversion_gap",
    name: "Short to Intermediate Reversion Gap",
    description: "Ranks intermediate directional return after weighting out short-term directional return.",
    defaultParams: { shortPullbackWeight: 2.0 },
    paramLabels: { shortPullbackWeight: "Weight on 12-bar directional return subtracted from 48-bar return" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/short_to_intermediate_reversion_gap.ts"],
    },
    score: (candidate, _event, params) => {
        const ret12 = candidate.feat_fp_spread_log_return_b12_r1;
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        if (ret12 === null || ret48 === null) return Number.NEGATIVE_INFINITY;
        const sign = candidate.direction === "long" ? 1 : -1;
        return sign * ret48 - params.shortPullbackWeight! * sign * ret12;
    },
};
