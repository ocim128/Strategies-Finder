import type { SelectionRule } from "./types";

/** Measured median activePairCount on the jedw surface — the normalization anchor. */
const REFERENCE_PAIRS = 60;

export const coverage_confirmed_votes: SelectionRule = {
    key: "coverage_confirmed_votes",
    name: "Coverage-Confirmed Votes",
    description:
        "signedVotes x (activePairCount/60)^coverageElasticity. Rewards candidates strong on BOTH vote volume and coverage. Elasticity 0 approaches TOP_RAW ordering; 1 is the product family; negative discounts coverage.",
    defaultParams: { coverageElasticity: 1 },
    paramLabels: { coverageElasticity: "Coverage elasticity" },
    normalizeParams(params) {
        const raw = typeof params.coverageElasticity === "number" && Number.isFinite(params.coverageElasticity)
            ? params.coverageElasticity
            : 1;
        return { coverageElasticity: Math.max(-3, Math.min(3, raw)) };
    },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        return candidate.signedVotes * Math.pow(candidate.activePairCount / REFERENCE_PAIRS, params.coverageElasticity!);
    },
};
