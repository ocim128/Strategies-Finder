import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithAtrRatio = PairCandidate & {
    feat_atrRatio5Over20?: number | null;
};

export const volatility_expansion_ratio_target: PairSelectionRule = {
    key: "volatility_expansion_ratio_target",
    name: "VOLATILITY_EXPANSION_RATIO_TARGET",
    description: "Targets a chosen short-to-medium ATR expansion ratio.",
    defaultParams: { targetAtrRatio: 1.25 },
    paramLabels: { targetAtrRatio: "Target ATR ratio" },
    score: (candidate, _event, params) => {
        const atrRatio = (candidate as CandidateWithAtrRatio).feat_atrRatio5Over20 ?? null;
        if (atrRatio === null || !Number.isFinite(atrRatio)) return Number.NEGATIVE_INFINITY;
        return -Math.abs(atrRatio - params.targetAtrRatio!);
    },
};
