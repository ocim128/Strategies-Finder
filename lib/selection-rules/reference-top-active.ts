import type { SelectionRule } from "./types";

/** Fixed seed reference: current active pair count. */
export const top_active: SelectionRule = {
    key: "top_active",
    name: "TOP_ACTIVE",
    description: "Selects the positive candidate with the highest activePairCount.",
    defaultParams: {},
    paramLabels: {},
    score(candidate) {
        if (candidate.signedVotes <= 0) return Number.NEGATIVE_INFINITY;
        return candidate.activePairCount;
    },
};
