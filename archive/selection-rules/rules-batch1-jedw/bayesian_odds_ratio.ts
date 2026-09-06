import type { SelectionRule } from "./types";

export const bayesian_odds_ratio: SelectionRule = {
    key: "bayesian_odds_ratio",
    name: "Bayesian Odds Ratio",
    description:
        "Ranks positive candidates by signedVotes divided by inactive pairs plus smoothingPairs, where inactive pairs are activePairCount minus signedVotes floored at zero. Non-positive votes or active pairs are ineligible.",
    defaultParams: { smoothingPairs: 5.0 },
    paramLabels: { smoothingPairs: "Inactive-pair smoothing" },
    normalizeParams(params) {
        const raw = typeof params.smoothingPairs === "number" && Number.isFinite(params.smoothingPairs)
            ? params.smoothingPairs
            : 5;
        return { smoothingPairs: Math.max(Number.EPSILON, raw) };
    },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const inactivePairs = Math.max(0, candidate.activePairCount - candidate.signedVotes);
        return candidate.signedVotes / (inactivePairs + params.smoothingPairs!);
    },
};
