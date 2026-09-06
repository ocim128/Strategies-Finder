import { medianValid, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const historical_spread_calm: PairSelectionRule = {
    key: "historical_spread_calm",
    name: "HISTORICAL_SPREAD_CALM",
    description: "Targets a chosen multiple of the event-median pair spread volatility.",
    defaultParams: { targetRelativeSpreadVolatility: 0.75 },
    paramLabels: { targetRelativeSpreadVolatility: "Target relative spread volatility" },
    score: (candidate, _event, params, pool) => {
        const volatility = candidate.feat_pairSpreadVolatility20;
        const eventMedian = memoByPool(pool, () => medianValid(pool, (entry) => entry.feat_pairSpreadVolatility20));
        if (volatility === null || eventMedian === null || eventMedian <= 0) return Number.NEGATIVE_INFINITY;
        return -Math.abs(volatility / eventMedian - params.targetRelativeSpreadVolatility!);
    },
};
