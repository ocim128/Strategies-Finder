import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithIntervalCv = PairCandidate & {
    feat_pairInterFireIntervalCvPrior?: number | null;
};

export const inter_fire_cadence_regularity: PairSelectionRule = {
    key: "inter_fire_cadence_regularity",
    name: "INTER_FIRE_CADENCE_REGULARITY",
    description: "Prefers pairs with lower prior inter-fire interval variability.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_pairInterFireIntervalCvPrior"] },
        sourceFiles: ["lib/pair-selection/inter_fire_cadence_regularity.ts"],
    },
    score: (candidate) => {
        const intervalCv = (candidate as CandidateWithIntervalCv).feat_pairInterFireIntervalCvPrior ?? null;
        if (intervalCv === null || !Number.isFinite(intervalCv)) return Number.NEGATIVE_INFINITY;
        return -intervalCv;
    },
};
