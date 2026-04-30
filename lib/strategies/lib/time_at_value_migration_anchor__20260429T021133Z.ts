import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

function normalizeTimeAtValueMigrationAnchorParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 100)),
        threshold: Math.max(0.5, Math.min(0.99, Number(params.threshold ?? 0.8))),
    };
}

export const time_at_value_migration_anchor: Strategy = {
    name: "Time-at-Value Migration Anchor",
    description:
        "Uses a rolling median as a fair-value proxy and requires percentile-rank persistence at distribution extremes before treating the move as a trend migration.",
    defaultParams: {
        lookback: 100,
        threshold: 0.8,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Percentile Threshold",
    },
    normalizeParams: normalizeTimeAtValueMigrationAnchorParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTimeAtValueMigrationAnchorParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const rank = buildPercentileRank(closes, lookback);

        return createSignalLoop(cleanData, [median, rank], (i) => {
            if (i < lookback - 1) return null;

            const med = median[i];
            const pctRank = rank[i];
            if (med === null || pctRank === null) return null;

            if (closes[i] > med && pctRank > (p.threshold as number)) {
                return createBuySignal(cleanData, i, `Close above value anchor with percentile rank ${pctRank.toFixed(2)}`);
            }
            if (closes[i] < med && pctRank < 1 - (p.threshold as number)) {
                return createSellSignal(cleanData, i, `Close below value anchor with percentile rank ${pctRank.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold"],
    },
};
