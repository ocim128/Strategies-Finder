import type { SelectionRule } from "./types";

export const excess_vote_density: SelectionRule = {
    key: "excess_vote_density",
    name: "Excess Vote Density",
    description:
        "Ranks positive candidates by the excess votes above voteNoiseFloor divided by activePairCount, flooring excess votes at zero. Non-positive votes or active pairs are ineligible.",
    defaultParams: { voteNoiseFloor: 8.0 },
    paramLabels: { voteNoiseFloor: "Vote noise floor" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        return Math.max(0, candidate.signedVotes - params.voteNoiseFloor!) / candidate.activePairCount;
    },
};
