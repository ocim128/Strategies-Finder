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
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 28))),
    };
}

export const extreme_age_exhaustion_wick_spike_fade: Strategy = {
    name: "Extreme Age Exhaustion Wick Spike Fade",
    description: "Fades climactic exhaustion spikes printing fresh extremes on outsized range bars with massive 60%+ rejection wicks.",
    defaultParams: {
        lookback: 28,
    },
    paramLabels: {
        lookback: "Lookback Period",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const lookback = Number(params.lookback);

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, lookback);
        const ranges = buildRangeSeries(cleanData);
        const avgRange = buildRollingAverage(ranges, lookback);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow, avgRange], (i) => {
            const sh = sinceHigh[i];
            const sl = sinceLow[i];
            const ar = avgRange[i];
            if (ar === null) return null;

            const bar = cleanData[i];
            const barRange = bar.high - bar.low;
            if (barRange <= 0 || barRange <= ar * 1.8) return null;

            if (sl !== null && sl === 0 && (bar.close - bar.low) >= barRange * 0.60) {
                return createBuySignal(cleanData, i, `Bullish exhaustion spike fade: fresh low, range=${barRange.toFixed(2)}>1.8*avg, lower rejection wick/bounce>=60%`);
            }
            if (sh !== null && sh === 0 && (bar.high - bar.close) >= barRange * 0.60) {
                return createSellSignal(cleanData, i, `Bearish exhaustion spike fade: fresh high, range=${barRange.toFixed(2)}>1.8*avg, upper rejection wick>=60%`);
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
