import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithSpreadVolatilityRatio = PairCandidate & {
    feat_pairSpreadVolatilityRatio5Over20?: number | null;
};

export const spread_volatility_trend_ratio: PairSelectionRule = {
    key: "spread_volatility_trend_ratio",
    name: "SPREAD_VOLATILITY_TREND_RATIO",
    description: "Targets a chosen short-to-medium spread-volatility ratio.",
    defaultParams: { targetSpreadVolRatio: 0.75 },
    paramLabels: { targetSpreadVolRatio: "Target spread volatility ratio" },
    metadata: {
        featureRequirements: { libraryRelease: "v1", columns: ["feat_pairSpreadVolatilityRatio5Over20"] },
        sourceFiles: ["lib/pair-selection/spread_volatility_trend_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const ratio = (candidate as CandidateWithSpreadVolatilityRatio).feat_pairSpreadVolatilityRatio5Over20 ?? null;
        if (ratio === null || !Number.isFinite(ratio)) return Number.NEGATIVE_INFINITY;
        return -Math.abs(ratio - params.targetSpreadVolRatio!);
    },
};
