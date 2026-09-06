import type { SelectionRule } from "./types";

export const event_vote_dominance_boost: SelectionRule = {
    key: "event_vote_dominance_boost",
    name: "Event Vote Dominance Boost",
    description:
        "Ranks positive candidates by signedVotes / activePairCount multiplied by the candidate-to-runner-up signed vote ratio raised to dominancePower. The runner-up denominator is floored at one when no other positive candidate has votes; non-positive votes or active pairs are ineligible.",
    defaultParams: { dominancePower: 0.5 },
    paramLabels: { dominancePower: "Vote dominance exponent" },
    score(candidate, _event, params, pool) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        let runnerUpVotes = 0;
        for (const poolCandidate of pool) {
            if (poolCandidate.asset !== candidate.asset) {
                runnerUpVotes = Math.max(runnerUpVotes, poolCandidate.signedVotes);
            }
        }
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        const dominanceRatio = candidate.signedVotes / Math.max(1, runnerUpVotes);
        return baseScore * Math.pow(dominanceRatio, params.dominancePower!);
    },
};
