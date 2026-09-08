import type { PairSelectionRule } from "./types";

export const fresh_fire_recency: PairSelectionRule = {
    key: "fresh_fire_recency",
    name: "FRESH_FIRE_RECENCY",
    description: "Targets a chosen number of bars since the pair's previous signal.",
    defaultParams: { targetBarsSinceLastFire: 1 },
    paramLabels: { targetBarsSinceLastFire: "Target bars since last fire" },
    score: (candidate, _event, params) => {
        const bars = candidate.feat_barsSincePairLastFire;
        if (bars === null) return Number.NEGATIVE_INFINITY;
        return -Math.abs(bars - params.targetBarsSinceLastFire!);
    },
};
