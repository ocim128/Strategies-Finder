import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithVarianceRatio = PairCandidate & {
    feat_spreadVarianceRatio5?: number | null;
};

export const spread_variance_ratio_target: PairSelectionRule = {
    key: "spread_variance_ratio_target",
    name: "SPREAD_VARIANCE_RATIO_TARGET",
    description: "Targets a chosen variance ratio of prior spread returns.",
    defaultParams: { targetVarianceRatio: 0.7 },
    paramLabels: { targetVarianceRatio: "Target variance ratio" },
    score: (candidate, _event, params) => {
        const varianceRatio = (candidate as CandidateWithVarianceRatio).feat_spreadVarianceRatio5 ?? null;
        if (varianceRatio === null || !Number.isFinite(varianceRatio)) return Number.NEGATIVE_INFINITY;
        return -Math.abs(varianceRatio - params.targetVarianceRatio!);
    },
};
