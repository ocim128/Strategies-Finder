import type { SelectionRule } from "./types";

const DEMOTION_FACTOR = 0.01;

export const rising_vote_acceleration_gate: SelectionRule = {
    key: "rising_vote_acceleration_gate",
    name: "Rising Vote Acceleration Gate",
    description:
        "Ranks positive candidates by signedVotes / activePairCount only when priorSignedVoteDelta3 is at least minVoteDelta; candidates below the threshold, including null warm-up values, are demoted by 100x. Non-positive votes or active pairs are ineligible.",
    defaultParams: { minVoteDelta: 1.0 },
    paramLabels: { minVoteDelta: "Minimum three-event vote delta" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        return candidate.priorSignedVoteDelta3 !== null
            && candidate.priorSignedVoteDelta3 >= params.minVoteDelta!
            ? baseScore
            : baseScore * DEMOTION_FACTOR;
    },
};
