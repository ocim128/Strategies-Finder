import type { SelectionRule } from "./types";

export const incumbent_momentum_tilt: SelectionRule = {
    key: "incumbent_momentum_tilt",
    name: "Incumbent Momentum Tilt",
    description:
        "Ranks positive candidates by signedVotes / activePairCount, tilted by priorTopMeanReturnMean3 with a floor of a 0.1 multiplier. A null prior incumbent return mean receives a neutral multiplier; non-positive votes or active pairs are ineligible.",
    defaultParams: { returnTiltWeight: 2.0 },
    paramLabels: { returnTiltWeight: "Prior incumbent return tilt" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        const priorReturn = candidate.priorTopMeanReturnMean3;
        if (priorReturn === null) return baseScore;
        return baseScore * Math.max(0.1, 1 + params.returnTiltWeight! * priorReturn);
    },
};
