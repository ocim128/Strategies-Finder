import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildAdjacentRangeOverlapSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const adjacent_overlap_structural_trend_channel: Strategy = {
    name: "Adjacent Overlap Structural Trend Channel",
    description: "Trades breakouts when multi-session rolling average adjacent overlap remains below 0.35, confirming active price discovery.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const avgOverlap = buildRollingAverage(overlap, lookback);

        return createSignalLoop(cleanData, [overlap, avgOverlap], (i) => {
            if (i < 1) return null;
            const avg = avgOverlap[i];
            if (avg === null || avg > 0.35) return null;

            if (cleanData[i].close > cleanData[i - 1].high) {
                return createBuySignal(cleanData, i, `Bullish structural trend breakout: avg overlap ${avg.toFixed(3)} <= 0.35, close > prior high`);
            }
            if (cleanData[i].close < cleanData[i - 1].low) {
                return createSellSignal(cleanData, i, `Bearish structural trend breakout: avg overlap ${avg.toFixed(3)} <= 0.35, close < prior low`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
