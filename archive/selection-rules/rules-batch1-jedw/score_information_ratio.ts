import type { SelectionRule } from "./types";

export const score_information_ratio: SelectionRule = {
    key: "score_information_ratio",
    name: "Score Information Ratio",
    description:
        "Ranks positive candidates by current signedVotes / activePairCount divided by volatilityRegularizer plus priorScoreStdDev5. Null priorScoreStdDev5 is assigned the regularizer as neutral dispersion; non-positive votes or active pairs are ineligible.",
    defaultParams: { volatilityRegularizer: 0.01 },
    paramLabels: { volatilityRegularizer: "Score-volatility regularizer" },
    normalizeParams(params) {
        const raw = typeof params.volatilityRegularizer === "number" && Number.isFinite(params.volatilityRegularizer)
            ? params.volatilityRegularizer
            : 0.01;
        return { volatilityRegularizer: Math.max(Number.EPSILON, raw) };
    },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        const observedStdDev = candidate.priorScoreStdDev5 === null
            ? params.volatilityRegularizer!
            : candidate.priorScoreStdDev5;
        return baseScore / (params.volatilityRegularizer! + observedStdDev);
    },
};
