import type { PairSelectionRule } from "./types";

export const spread_path_information_ratio: PairSelectionRule = {
    key: "spread_path_information_ratio",
    name: "Spread Path Information Ratio",
    description: "Ranks direction-aligned 48-bar return relative to trailing return volatility.",
    defaultParams: { volatilityPenaltyExponent: 1.0 },
    paramLabels: { volatilityPenaltyExponent: "Exponent applied to trailing return standard deviation" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_volatility_return_std_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/spread_path_information_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        const returnStd = candidate.feat_fp_volatility_return_std_b48_r1;
        if (ret48 === null || returnStd === null || returnStd <= 0) return Number.NEGATIVE_INFINITY;
        const dirRet48 = candidate.direction === "long" ? ret48 : -ret48;
        return dirRet48 / Math.pow(returnStd, params.volatilityPenaltyExponent!);
    },
};
