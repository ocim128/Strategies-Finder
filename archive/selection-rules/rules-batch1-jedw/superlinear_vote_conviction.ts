import type { SelectionRule } from "./types";

export const superlinear_vote_conviction: SelectionRule = {
    key: "superlinear_vote_conviction",
    name: "Superlinear Vote Conviction",
    description:
        "Ranks positive candidates by signedVotes raised to voteExponent and divided by activePairCount, breaking density ratio invariance in favor of high-volume consensus. Non-positive votes or active pairs are ineligible.",
    defaultParams: { voteExponent: 1.5 },
    paramLabels: { voteExponent: "Vote conviction exponent" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        return Math.pow(candidate.signedVotes, params.voteExponent!) / candidate.activePairCount;
    },
};
