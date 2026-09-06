import type { SelectionRule } from "./types";

export const stable_contraction_score: SelectionRule = {
    key: "stable_contraction_score",
    name: "Stable Contraction Score",
    description:
        "Ranks candidates by negative priorCoverageSlope5 minus volatilityPenalty times priorScoreStdDev5. Null coverage slope uses zero and null score standard deviation uses 0.01.",
    defaultParams: { volatilityPenalty: 20.0 },
    paramLabels: { volatilityPenalty: "Score-volatility penalty" },
    score(candidate, _event, params) {
        const slope = candidate.priorCoverageSlope5 === null ? 0 : candidate.priorCoverageSlope5;
        const stdDev = candidate.priorScoreStdDev5 === null ? 0.01 : candidate.priorScoreStdDev5;
        return -slope - params.volatilityPenalty! * stdDev;
    },
};
