import type { PairSelectionRule } from "./types";

export const trend_to_noise_volatility_ratio: PairSelectionRule = {
    key: "trend_to_noise_volatility_ratio",
    name: "Trend to Noise Volatility Ratio",
    description: "Scales direction-aligned 48-bar return by close-to-close volatility relative to ATR.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: ["lib/pair-selection/trend_to_noise_volatility_ratio.ts"],
    },
    score: (candidate) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        const spreadVolatility = candidate.feat_pairSpreadVolatility20;
        const atr = candidate.feat_atrPct;
        if (ret48 === null || spreadVolatility === null || atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        const directionalRet48 = candidate.direction === "long" ? ret48 : -ret48;
        return directionalRet48 * (spreadVolatility / atr);
    },
};
