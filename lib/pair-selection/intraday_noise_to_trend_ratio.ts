import type { PairSelectionRule } from "./types";

export const intraday_noise_to_trend_ratio: PairSelectionRule = {
    key: "intraday_noise_to_trend_ratio",
    name: "Intraday Noise to Trend Ratio",
    description: "Ranks signal ATR expansion relative to preceding 20-bar spread volatility.",
    defaultParams: { volFloor: 0.1 },
    paramLabels: { volFloor: "Floor added to 20-bar spread volatility to prevent division by near-zero" },
    metadata: {
        sourceFiles: ["lib/pair-selection/intraday_noise_to_trend_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const atr = candidate.feat_atrPct;
        const closeVol = candidate.feat_pairSpreadVolatility20;
        if (atr === null || closeVol === null || closeVol <= 0) return Number.NEGATIVE_INFINITY;
        return atr / (closeVol + params.volFloor!);
    },
};
