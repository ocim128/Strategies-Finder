import type { PairSelectionRule } from "./types";

export const directional_spread_sortino_ratio: PairSelectionRule = {
    key: "directional_spread_sortino_ratio",
    name: "Directional Spread Sortino Ratio",
    description: "Ranks direction-aligned 48-bar return against direction-aligned adverse semi-deviation.",
    defaultParams: { downsideRiskExponent: 1.0 },
    paramLabels: { downsideRiskExponent: "Exponent applied to adverse semi-deviation" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_volatility_downside_rms_b48_r1",
                "feat_fp_volatility_upside_rms_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/directional_spread_sortino_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        const adverseRms = candidate.direction === "long"
            ? candidate.feat_fp_volatility_downside_rms_b48_r1
            : candidate.feat_fp_volatility_upside_rms_b48_r1;
        if (ret48 === null || adverseRms === null || adverseRms <= 0) return Number.NEGATIVE_INFINITY;
        const dirRet48 = candidate.direction === "long" ? ret48 : -ret48;
        return dirRet48 / Math.pow(adverseRms, params.downsideRiskExponent!);
    },
};
