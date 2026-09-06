import type { SelectionRule } from "./types";

const DEMOTION_FACTOR = 0.01;

export const vote_quorum_density_gate: SelectionRule = {
    key: "vote_quorum_density_gate",
    name: "Vote Quorum Density Gate",
    description:
        "Ranks positive candidates by signedVotes / activePairCount after an absolute vote quorum: candidates at or above minVoteQuorum retain the density score, while smaller vote counts are demoted by 100x. Non-positive votes or active pairs are ineligible.",
    defaultParams: { minVoteQuorum: 16.0 },
    paramLabels: { minVoteQuorum: "Minimum vote quorum" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        return candidate.signedVotes >= params.minVoteQuorum!
            ? baseScore
            : baseScore * DEMOTION_FACTOR;
    },
};
