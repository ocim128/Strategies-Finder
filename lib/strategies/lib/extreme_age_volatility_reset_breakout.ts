import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildExtremeAgeSeries,
    buildRangeSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
    };
}

export const extreme_age_volatility_reset_breakout: Strategy = {
    name: "Extreme Age Volatility Reset Breakout",
    description: "Enters high-energy breakouts when price shatters maximum extreme age staleness with an outsized range bar.",
    defaultParams: {
        lookback: 30,
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

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, lookback);
        const range = buildRangeSeries(cleanData);
        const avgRange = buildRollingAverage(range, lookback);
        const staleMin = lookback - 2;

        return createSignalLoop(cleanData, [sinceHigh, sinceLow, range, avgRange], (i) => {
            if (i < 1) return null;
            const prevHighAge = sinceHigh[i - 1];
            const currHighAge = sinceHigh[i];
            const prevLowAge = sinceLow[i - 1];
            const currLowAge = sinceLow[i];
            const r = range[i];
            const avgR = avgRange[i];
            if (r === null || avgR === null) return null;

            const isOutsizedRange = r > avgR * 1.5;
            if (isOutsizedRange) {
                if (prevHighAge !== null && prevHighAge >= staleMin && currHighAge === 0 && cleanData[i].close > cleanData[i].open) {
                    return createBuySignal(cleanData, i, `Bullish volatility reset breakout: prior high age ${prevHighAge} >= ${staleMin}, reset to 0, range ${r.toFixed(3)} > 1.5x avg ${avgR.toFixed(3)}, close > open`);
                }
                if (prevLowAge !== null && prevLowAge >= staleMin && currLowAge === 0 && cleanData[i].close < cleanData[i].open) {
                    return createSellSignal(cleanData, i, `Bearish volatility reset breakout: prior low age ${prevLowAge} >= ${staleMin}, reset to 0, range ${r.toFixed(3)} > 1.5x avg ${avgR.toFixed(3)}, close < open`);
                }
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
