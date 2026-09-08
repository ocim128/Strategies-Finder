import type { PairSelectionRule } from "./types";

export const fresh_trend_emergence_ratio: PairSelectionRule = {
    key: "fresh_trend_emergence_ratio",
    name: "Fresh Trend Emergence Ratio",
    description: "Ranks short-term directional return after penalizing secular extension.",
    defaultParams: { secularExtensionPenalty: 1.0 },
    paramLabels: { secularExtensionPenalty: "Penalty weight applied to absolute 240-bar spread return" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b240_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/fresh_trend_emergence_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const ret12 = candidate.feat_fp_spread_log_return_b12_r1;
        const ret240 = candidate.feat_fp_spread_log_return_b240_r1;
        if (ret12 === null || ret240 === null) return Number.NEGATIVE_INFINITY;
        const sign = candidate.direction === "long" ? 1 : -1;
        const dirRet12 = sign * ret12;
        const dirRet240 = sign * ret240;
        return dirRet12 / (1 + params.secularExtensionPenalty! * Math.abs(dirRet240));
    },
};
