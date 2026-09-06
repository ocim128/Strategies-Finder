import { directionAdjusted, medianAbsoluteDeviation, medianValid, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface CrowdStats {
    values: number[];
    eventMedian: number | null;
    mad: number | null;
}

function crowdStats(pool: readonly PairCandidate[]): CrowdStats {
    return memoByPool(pool, "return20-crowd-stats", () => {
        const values = pool
            .map((entry) => directionAdjusted(entry, entry.feat_return20))
            .filter((value): value is number => value !== null);
        const eventMedian = medianValid(pool, (entry) => directionAdjusted(entry, entry.feat_return20));
        const mad = eventMedian === null ? null : medianAbsoluteDeviation(values, eventMedian);
        return { values, eventMedian, mad };
    });
}

export const crowd_relative_contrarian: PairSelectionRule = {
    key: "crowd_relative_contrarian",
    name: "CROWD_RELATIVE_CONTRARIAN",
    description: "Targets a direction-adjusted return gap from the event median in MAD units.",
    defaultParams: { targetReturnGapMad: -1 },
    paramLabels: { targetReturnGapMad: "Target return gap (MAD)" },
    score: (candidate, _event, params, pool) => {
        const candidateReturn = directionAdjusted(candidate, candidate.feat_return20);
        if (candidateReturn === null) return Number.NEGATIVE_INFINITY;
        const stats = crowdStats(pool);
        if (stats.values.length < 2 || stats.eventMedian === null) return Number.NEGATIVE_INFINITY;
        const mad = stats.mad;
        if (mad === null || mad === 0) return Number.NEGATIVE_INFINITY;
        return -Math.abs((candidateReturn - stats.eventMedian) / mad - params.targetReturnGapMad!);
    },
};
