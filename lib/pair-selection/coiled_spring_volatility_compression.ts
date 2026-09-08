import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithAtrRatio = PairCandidate & {
    feat_atrRatio5Over20?: number | null;
};

export const coiled_spring_volatility_compression: PairSelectionRule = {
    key: "coiled_spring_volatility_compression",
    name: "Coiled Spring Volatility Compression",
    description: "Prefers the lowest valid 5-bar to 20-bar ATR ratio.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_atrRatio5Over20"] },
        sourceFiles: ["lib/pair-selection/coiled_spring_volatility_compression.ts"],
    },
    score: (candidate) => {
        const ratio = (candidate as CandidateWithAtrRatio).feat_atrRatio5Over20 ?? null;
        if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return Number.NEGATIVE_INFINITY;
        return -ratio;
    },
};
