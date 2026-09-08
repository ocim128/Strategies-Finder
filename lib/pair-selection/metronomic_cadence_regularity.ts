import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithIntervalCv = PairCandidate & {
    feat_pairInterFireIntervalCvPrior?: number | null;
};

export const metronomic_cadence_regularity: PairSelectionRule = {
    key: "metronomic_cadence_regularity",
    name: "Metronomic Cadence Regularity",
    description: "Ranks pairs with lower prior inter-fire interval variability.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_pairInterFireIntervalCvPrior"] },
        sourceFiles: ["lib/pair-selection/metronomic_cadence_regularity.ts"],
    },
    score: (candidate) => {
        const cv = (candidate as CandidateWithIntervalCv).feat_pairInterFireIntervalCvPrior ?? null;
        if (cv === null || !Number.isFinite(cv) || cv < 0) return Number.NEGATIVE_INFINITY;
        return -cv;
    },
};
