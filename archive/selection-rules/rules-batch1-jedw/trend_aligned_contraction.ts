import type { SelectionRule } from "./types";

export const trend_aligned_contraction: SelectionRule = {
    key: "trend_aligned_contraction",
    name: "Trend-Aligned Contraction",
    description:
        "Ranks candidates by 1.5 minus priorCoverageSlope5, multiplying below-EMA candidates by counterTrendWeight. Null priorCoverageSlope5 uses zero slope and a 1.5 contraction score.",
    defaultParams: { counterTrendWeight: 0.2 },
    paramLabels: { counterTrendWeight: "Counter-trend weight" },
    score(candidate, _event, params) {
        const slope = candidate.priorCoverageSlope5 === null ? 0 : candidate.priorCoverageSlope5;
        const contractionScore = 1.5 - slope;
        const trendMultiplier = candidate.ema200Above ? 1 : params.counterTrendWeight!;
        return contractionScore * trendMultiplier;
    },
};
