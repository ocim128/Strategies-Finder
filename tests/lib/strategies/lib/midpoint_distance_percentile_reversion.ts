import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        percentileThreshold: Math.max(0.5, Math.min(1.0, Number(params.percentileThreshold ?? 0.95))),
    };
}

export const midpoint_distance_percentile_reversion: Strategy = {
    name: "Midpoint Distance Percentile Reversion",
    description: "Fades close price deviations from the bar's midpoint at extreme percentile levels.",
    defaultParams: {
        lookback: 30,
        percentileThreshold: 0.95,
    },
    paramLabels: {
        lookback: "Lookback Window",
        percentileThreshold: "Percentile Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const rawDevs = extractBarMetricSeries(cleanData, "closeMidpointDev");
        const absDevs = rawDevs.map((v) => Math.abs(v));
        const percentile = buildPercentileRank(absDevs, lookback);

        return createSignalLoop(cleanData, [percentile], (i) => {
            const pRank = percentile[i];
            if (pRank === null) return null;

            const bar = cleanData[i];
            const midpoint = (bar.high + bar.low) / 2;
            const close = closes[i];

            if (pRank > p.percentileThreshold) {
                // Buy: close is below midpoint, and percentile rank is extreme
                if (close < midpoint) {
                    return createBuySignal(cleanData, i, `Midpoint distance buy: percentile ${pRank.toFixed(2)}, close ${close.toFixed(4)} < midpoint ${midpoint.toFixed(4)}`);
                }
                // Sell: close is above midpoint, and percentile rank is extreme
                if (close > midpoint) {
                    return createSellSignal(cleanData, i, `Midpoint distance sell: percentile ${pRank.toFixed(2)}, close ${close.toFixed(4)} > midpoint ${midpoint.toFixed(4)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "percentileThreshold"],
    },
};
