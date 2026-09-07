import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithHalfLife = PairCandidate & {
    feat_spreadHalfLifeBars20?: number | null;
};

export const spread_mean_reversion_halflife: PairSelectionRule = {
    key: "spread_mean_reversion_halflife",
    name: "SPREAD_MEAN_REVERSION_HALFLIFE",
    description: "Targets a chosen prior spread mean-reversion half-life in bars.",
    defaultParams: { targetHalfLifeBars: 6 },
    paramLabels: { targetHalfLifeBars: "Target half-life (bars)" },
    score: (candidate, _event, params) => {
        const halfLife = (candidate as CandidateWithHalfLife).feat_spreadHalfLifeBars20 ?? null;
        if (halfLife === null || !Number.isFinite(halfLife)) return Number.NEGATIVE_INFINITY;
        return -Math.abs(halfLife - params.targetHalfLifeBars!);
    },
};
