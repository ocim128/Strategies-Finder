import type { SelectionRule } from "./types";

const DEMOTION_FACTOR = 0.01;

export const losing_incumbent_demotion: SelectionRule = {
    key: "losing_incumbent_demotion",
    name: "Losing Incumbent Demotion",
    description:
        "Ranks positive candidates by signedVotes / activePairCount and demotes candidates by 100x when their priorTopMeanReturnMean3 is below negative lossThreshold. Null and non-losing prior incumbent returns are not demoted; non-positive votes or active pairs are ineligible.",
    defaultParams: { lossThreshold: 0.02 },
    paramLabels: { lossThreshold: "Prior incumbent loss threshold" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        const priorReturn = candidate.priorTopMeanReturnMean3;
        return priorReturn !== null && priorReturn < -params.lossThreshold!
            ? baseScore * DEMOTION_FACTOR
            : baseScore;
    },
};
