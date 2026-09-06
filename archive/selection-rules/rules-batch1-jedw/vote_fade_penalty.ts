import type { SelectionRule } from "./types";

export const vote_fade_penalty: SelectionRule = {
    key: "vote_fade_penalty",
    name: "Vote Fade Penalty",
    description:
        "Ranks positive candidates by signedVotes / activePairCount and applies a linear penalty only when priorSignedVoteDelta3 is negative, floored at a 0.01 multiplier. Null priorSignedVoteDelta3 receives no penalty; non-positive votes or active pairs are ineligible.",
    defaultParams: { fadePenaltyWeight: 0.25 },
    paramLabels: { fadePenaltyWeight: "Vote-fade penalty weight" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        const delta = candidate.priorSignedVoteDelta3;
        if (delta === null || delta >= 0) return baseScore;
        return baseScore * Math.max(0.01, 1 - params.fadePenaltyWeight! * Math.abs(delta));
    },
};
