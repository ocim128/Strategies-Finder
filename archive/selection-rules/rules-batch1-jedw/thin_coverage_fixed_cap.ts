import type { SelectionRule } from "./types";

const DEMOTION_FACTOR = 0.01;

export const thin_coverage_fixed_cap: SelectionRule = {
    key: "thin_coverage_fixed_cap",
    name: "Thin Coverage Fixed Cap",
    description:
        "Selects by signedVotes for candidates with activePairCount at or below maxPairCount and demotes broader candidates by 100x; non-positive signedVotes are ineligible.",
    defaultParams: { maxPairCount: 52.0 },
    paramLabels: { maxPairCount: "Maximum active pair count" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0) return Number.NEGATIVE_INFINITY;
        return candidate.activePairCount <= params.maxPairCount!
            ? candidate.signedVotes
            : candidate.signedVotes * DEMOTION_FACTOR;
    },
};
