import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithCadence = PairCandidate & {
    feat_pairInterFireIntervalCvPrior?: number | null;
};

export const rhythmic_cadence_loud_atr: PairSelectionRule = {
    key: "rhythmic_cadence_loud_atr",
    name: "Rhythmic Cadence Loud ATR",
    description: "Discounts signal ATR percentage by prior inter-fire interval variability.",
    defaultParams: { cvPenalty: 0.5 },
    paramLabels: { cvPenalty: "Penalty weight applied per unit of inter-fire interval coefficient of variation" },
    metadata: {
        featureRequirements: { libraryRelease: "v1", columns: ["feat_pairInterFireIntervalCvPrior"] },
        sourceFiles: ["lib/pair-selection/rhythmic_cadence_loud_atr.ts"],
    },
    score: (candidate, _event, params) => {
        const atr = candidate.feat_atrPct;
        const cv = (candidate as CandidateWithCadence).feat_pairInterFireIntervalCvPrior;
        if (atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return atr / (1 + (cv ?? 1) * params.cvPenalty!);
    },
};
