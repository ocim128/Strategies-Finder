import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithMae = PairCandidate & {
    feat_pairMedianMaePctPrior?: number | null;
};

export const historical_adverse_excursion_target: PairSelectionRule = {
    key: "historical_adverse_excursion_target",
    name: "HISTORICAL_ADVERSE_EXCURSION_TARGET",
    description: "Targets a chosen prior median maximum adverse excursion percentage.",
    defaultParams: { targetMaePct: 1.0 },
    paramLabels: { targetMaePct: "Target MAE (%)" },
    score: (candidate, _event, params) => {
        const mae = (candidate as CandidateWithMae).feat_pairMedianMaePctPrior ?? null;
        if (mae === null || !Number.isFinite(mae)) return Number.NEGATIVE_INFINITY;
        return -Math.abs(mae - params.targetMaePct!);
    },
};
