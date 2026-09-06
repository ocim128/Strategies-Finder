import type { SelectionRule } from "./types";

export const counter_breadth_trend_strength: SelectionRule = {
    key: "counter_breadth_trend_strength",
    name: "Counter-Breadth Trend Strength",
    description:
        "Ranks positive candidates by signedVotes / activePairCount, boosting candidates above their 200-period EMA by divergenceWeight times the event's breadth deficit from one. Null breadth uses the 0.65 median default; non-positive votes or active pairs are ineligible.",
    defaultParams: { divergenceWeight: 0.5 },
    paramLabels: { divergenceWeight: "Counter-breadth divergence weight" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        const eventBreadth = candidate.breadth === null ? 0.65 : candidate.breadth;
        const resilienceBonus = candidate.ema200Above
            ? 1 + params.divergenceWeight! * Math.max(0, 1 - eventBreadth)
            : 1;
        return baseScore * resilienceBonus;
    },
};
