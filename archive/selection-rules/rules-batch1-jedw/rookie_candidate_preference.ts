import type { SelectionRule } from "./types";

export const rookie_candidate_preference: SelectionRule = {
    key: "rookie_candidate_preference",
    name: "Rookie Candidate Preference",
    description:
        "Ranks positive candidates by signedVotes / activePairCount and discounts candidates with a completed priorTopMeanReturnMean3 history by alumniDiscount. Null prior incumbent return means are treated as fresh rookies with no discount; non-positive votes or active pairs are ineligible.",
    defaultParams: { alumniDiscount: 0.2 },
    paramLabels: { alumniDiscount: "Incumbent alumni discount" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        return candidate.priorTopMeanReturnMean3 !== null
            ? baseScore * (1 - params.alumniDiscount!)
            : baseScore;
    },
};
