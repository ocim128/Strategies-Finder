import type { SelectionRule } from "./types";

export const incumbent_reversal_tilt: SelectionRule = {
    key: "incumbent_reversal_tilt",
    name: "Incumbent Reversal Tilt",
    description:
        "Ranks positive candidates by signedVotes / activePairCount, tilting inversely against priorTopMeanReturnMean3 with a floor of a 0.1 multiplier. Null prior incumbent return means receive a neutral multiplier; non-positive votes or active pairs are ineligible.",
    defaultParams: { reversalTiltWeight: 2.0 },
    paramLabels: { reversalTiltWeight: "Incumbent reversal tilt" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        const priorReturn = candidate.priorTopMeanReturnMean3;
        if (priorReturn === null) return baseScore;
        return baseScore * Math.max(0.1, 1 - params.reversalTiltWeight! * priorReturn);
    },
};
