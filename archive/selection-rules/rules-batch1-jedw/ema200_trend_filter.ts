import type { SelectionRule } from "./types";

export const ema200_trend_filter: SelectionRule = {
    key: "ema200_trend_filter",
    name: "EMA200 Trend Filter",
    description:
        "Ranks positive candidates by signedVotes / activePairCount, leaving candidates above their 200-period EMA unchanged and multiplying below-EMA candidates by belowEmaWeight. Non-positive votes or active pairs are ineligible.",
    defaultParams: { belowEmaWeight: 0.2 },
    paramLabels: { belowEmaWeight: "Below-EMA score weight" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        return candidate.ema200Above ? baseScore : baseScore * params.belowEmaWeight!;
    },
};
