import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateRSI, calculateStochastic } from "../indicators";
import { buildRollingMedian } from "./price-action-statistics-core";

const RSI_STOCH_ANCHOR_MEDIAN = 55;

function normalizeRsiStochExtremeOrParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 14))),
        rsi_threshold: Math.max(50, Math.min(99, Number(params.rsi_threshold ?? 60))),
    };
}

export const rsi_stoch_extreme_or: Strategy = {
    name: "RSI-Stoch Extreme OR",
    description:
        "Accepts either RSI momentum or Stochastic range-position momentum when price is on the correct side of a stable median anchor.",
    defaultParams: {
        lookback: 14,
        rsi_threshold: 60,
    },
    paramLabels: {
        lookback: "Lookback",
        rsi_threshold: "RSI Threshold",
    },
    normalizeParams: normalizeRsiStochExtremeOrParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRsiStochExtremeOrParams(params);
        const lookback = p.lookback as number;
        const rsiThreshold = p.rsi_threshold as number;
        if (cleanData.length < RSI_STOCH_ANCHOR_MEDIAN + lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const rsi = calculateRSI(closes, lookback);
        const stochastic = calculateStochastic(highs, lows, closes, lookback, 3);
        const median = buildRollingMedian(closes, RSI_STOCH_ANCHOR_MEDIAN);

        return createSignalLoop(cleanData, [rsi, stochastic.k, median], (i) => {
            const oscillator = rsi[i];
            const stochK = stochastic.k[i];
            const med = median[i];
            if (oscillator === null || stochK === null || med === null) return null;

            const longSignal = (oscillator > rsiThreshold || stochK > 80) && closes[i] > med;
            const shortSignal = (oscillator < 100 - rsiThreshold || stochK < 20) && closes[i] < med;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, `RSI/Stoch momentum long rsi=${oscillator.toFixed(1)} k=${stochK.toFixed(1)}`);
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, `RSI/Stoch momentum short rsi=${oscillator.toFixed(1)} k=${stochK.toFixed(1)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rsi_threshold"],
    },
};
