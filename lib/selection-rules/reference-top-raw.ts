import type { SelectionRule } from "./types";

/** Fixed archived reference: current signed votes. */
export const top_raw: SelectionRule = {
    key: "top_raw",
    name: "TOP_RAW",
    description: "Selects the positive candidate with the highest current signedVotes.",
    defaultParams: {},
    paramLabels: {},
    score(candidate) {
        if (candidate.signedVotes <= 0) return Number.NEGATIVE_INFINITY;
        return candidate.signedVotes;
    },
};
