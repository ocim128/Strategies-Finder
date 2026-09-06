import type { SelectionRule } from "./types";

/** Fixed archived reference: current signed votes divided by active pairs. */
export const top_mean: SelectionRule = {
    key: "top_mean",
    name: "TOP_MEAN",
    description: "Selects the positive candidate with the highest current signedVotes / activePairCount.",
    defaultParams: {},
    paramLabels: {},
    score(candidate) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        return candidate.signedVotes / candidate.activePairCount;
    },
};
