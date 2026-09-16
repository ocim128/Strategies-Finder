import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRangeSeries,
    buildRollingAverage,
    buildWindowGivebackRatio,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 24))),
    };
}

export const window_giveback_exhausted_breakdown_fade: Strategy = {
    name: "Window Giveback Exhausted Breakdown Fade",
    description: "Fades 0.618 Fibonacci breakdowns that occur on tiny, low-energy range bars with zero institutional momentum.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Lookback Period",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const lookback = Number(params.lookback);
        const closes = getCloses(cleanData);

        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const ranges = buildRangeSeries(cleanData);
        const avgRange = buildRollingAverage(ranges, lookback);

        return createSignalLoop(cleanData, [gb, avgRange], (i) => {
            if (i < lookback + 1) return null;
            const gPrev = gb[i - 1];
            const gCurr = gb[i];
            const ar = avgRange[i];
            if (gPrev === null || gCurr === null || ar === null) return null;

            const barRange = cleanData[i].high - cleanData[i].low;

            if (gPrev <= 0.618 && gCurr > 0.618 && barRange < ar * 0.50) {
                if (closes[i - 1] > closes[i - 1 - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish exhausted breakdown fade: 0.618 breach on tiny range (${barRange.toFixed(2)} < 0.5*avg), up-window`);
                }
                if (closes[i - 1] < closes[i - 1 - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish exhausted breakdown fade: 0.618 breach on tiny range (${barRange.toFixed(2)} < 0.5*avg), down-window`);
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
