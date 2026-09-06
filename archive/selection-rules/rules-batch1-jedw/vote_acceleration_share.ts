import type { SelectionRule } from "./types";

export const vote_acceleration_share: SelectionRule = {
    key: "vote_acceleration_share",
    name: "Vote Acceleration Share",
    description:
        "Ranks positive candidates by signedVotes / activePairCount tilted by relative vote growth, priorSignedVoteDelta3 / signedVotes, with the multiplier floored at 0.1. Null priorSignedVoteDelta3 receives a zero growth rate; non-positive votes or active pairs are ineligible.",
    defaultParams: { growthWeight: 1.5 },
    paramLabels: { growthWeight: "Relative vote-growth weight" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        const growthRate = candidate.priorSignedVoteDelta3 === null
            ? 0
            : candidate.priorSignedVoteDelta3 / candidate.signedVotes;
        return baseScore * Math.max(0.1, 1 + params.growthWeight! * growthRate);
    },
};
