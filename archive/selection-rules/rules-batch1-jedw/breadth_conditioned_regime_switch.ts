import type { SelectionRule } from "./types";

export const breadth_conditioned_regime_switch: SelectionRule = {
    key: "breadth_conditioned_regime_switch",
    name: "Breadth-Conditioned Regime Switch",
    description:
        "Uses signedVotes when event breadth is at least breadthThreshold and signedVotes / activePairCount otherwise. A null breadth defaults to the density-normalized TOP_MEAN score; non-positive votes or active pairs are ineligible.",
    defaultParams: { breadthThreshold: 0.65 },
    paramLabels: { breadthThreshold: "Breadth regime threshold" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        return candidate.breadth !== null && candidate.breadth >= params.breadthThreshold!
            ? candidate.signedVotes
            : candidate.signedVotes / candidate.activePairCount;
    },
};
