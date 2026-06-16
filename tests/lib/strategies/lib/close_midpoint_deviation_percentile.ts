import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        pctlExtreme: Math.max(0.5, Math.min(1.0, Number(params.pctlExtreme ?? 0.85))),
    };
}

export const close_midpoint_deviation_percentile: Strategy = {
    name: "Close Midpoint Deviation Percentile",
    description: "Fades single-bar extremes measured as the close's deviation from the body midpoint.",
    defaultParams: {
        lookback: 30,
        pctlExtreme: 0.85,
    },
    paramLabels: {
        lookback: "Lookback Window",
        pctlExtreme: "Percentile Extreme",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const deviations: number[] = new Array(cleanData.length).fill(0);
        const midpoints: number[] = new Array(cleanData.length).fill(0);

        for (let i = 0; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const range = bar.high - bar.low;
            const midpoint = (bar.open + bar.close) / 2;
            midpoints[i] = midpoint;
            deviations[i] = range > 0 ? Math.abs(bar.close - midpoint) / range : 0;
        }

        const percentile = buildPercentileRank(deviations, lookback);

        return createSignalLoop(cleanData, [percentile], (i) => {
            const pRank = percentile[i];
            if (pRank === null) return null;

            const close = cleanData[i].close;
            const midpoint = midpoints[i];

            if (pRank > p.pctlExtreme) {
                // Buy: close is pushed below body midpoint at a percentile extreme -> long reversion
                if (close < midpoint) {
                    return createBuySignal(cleanData, i, `Midpoint dev buy: percentile ${pRank.toFixed(2)}, close ${close.toFixed(4)} < mid ${midpoint.toFixed(4)}`);
                }
                // Sell: close is pushed above body midpoint at a percentile extreme -> short reversion
                if (close > midpoint) {
                    return createSellSignal(cleanData, i, `Midpoint dev sell: percentile ${pRank.toFixed(2)}, close ${close.toFixed(4)} > mid ${midpoint.toFixed(4)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pctlExtreme"],
    },
};
