import type { SelectionRule } from "./types";

export const trend_momentum_thinness: SelectionRule = {
    key: "trend_momentum_thinness",
    name: "Trend-Momentum Thinness",
    description:
        "Ranks candidates by base thinness plus five times priorSignedVoteDelta3, multiplying below-EMA candidates by belowEmaDiscount. Null priorSignedVoteDelta3 receives a zero momentum term.",
    defaultParams: { belowEmaDiscount: 0.2 },
    paramLabels: { belowEmaDiscount: "Below-EMA thinness discount" },
    score(candidate, _event, params) {
        const baseThinness = 100 - candidate.activePairCount;
        const delta = candidate.priorSignedVoteDelta3 === null ? 0 : candidate.priorSignedVoteDelta3;
        const momentumTerm = delta * 5;
        const trendMultiplier = candidate.ema200Above ? 1 : params.belowEmaDiscount!;
        return (baseThinness + momentumTerm) * trendMultiplier;
    },
};
