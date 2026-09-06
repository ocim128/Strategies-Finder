import type { SelectionRule } from "./types";

export const poisson_vote_elasticity: SelectionRule = {
    key: "poisson_vote_elasticity",
    name: "Poisson Vote Elasticity",
    description:
        "Selects positive candidates by signedVotes divided by activePairCount raised to coveragePower, using square-root Poisson scaling by default; non-positive votes or active pairs are ineligible.",
    defaultParams: { coveragePower: 0.5 },
    paramLabels: { coveragePower: "Coverage exponent" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        return candidate.signedVotes / Math.pow(candidate.activePairCount, params.coveragePower!);
    },
};
