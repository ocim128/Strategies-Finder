import { medianValid } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const relative_atr_cleanliness: PairSelectionRule = {
    key: "relative_atr_cleanliness",
    name: "RELATIVE_ATR_CLEANLINESS",
    description: "Targets a chosen multiple of the event-median signal ATR.",
    defaultParams: { targetRelativeAtr: 0.75 },
    paramLabels: { targetRelativeAtr: "Target relative ATR" },
    score: (candidate, _event, _params, pool) => {
        const atr = candidate.feat_atrPct;
        const eventMedian = medianValid(pool, (entry) => entry.feat_atrPct);
        if (atr === null || eventMedian === null || eventMedian <= 0) return Number.NEGATIVE_INFINITY;
        return -Math.abs(atr / eventMedian - _params.targetRelativeAtr!);
    },
};
