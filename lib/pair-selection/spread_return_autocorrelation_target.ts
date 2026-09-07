import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithAutocorrelation = PairCandidate & {
    feat_spreadReturnAutocorr20?: number | null;
};

export const spread_return_autocorrelation_target: PairSelectionRule = {
    key: "spread_return_autocorrelation_target",
    name: "SPREAD_RETURN_AUTOCORRELATION_TARGET",
    description: "Targets a chosen lag-1 autocorrelation of prior spread returns.",
    defaultParams: { targetAutocorr: -0.25 },
    paramLabels: { targetAutocorr: "Target return autocorrelation" },
    score: (candidate, _event, params) => {
        const autocorrelation = (candidate as CandidateWithAutocorrelation).feat_spreadReturnAutocorr20 ?? null;
        if (autocorrelation === null || !Number.isFinite(autocorrelation)) return Number.NEGATIVE_INFINITY;
        return -Math.abs(autocorrelation - params.targetAutocorr!);
    },
};
