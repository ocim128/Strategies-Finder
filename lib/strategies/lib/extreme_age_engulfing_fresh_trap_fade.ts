import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildExtremeAgeSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 26))),
    };
}

export const extreme_age_engulfing_fresh_trap_fade: Strategy = {
    name: "Extreme Age Engulfing Fresh Trap Fade",
    description: "Fades outside engulfing traps printed immediately at freshly minted window extremes.",
    defaultParams: {
        lookback: 26,
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

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            if (i < 1) return null;
            const sh = sinceHigh[i];
            const sl = sinceLow[i];

            const curr = cleanData[i];
            const prev = cleanData[i - 1];

            // Fresh low printed, but candle reverses into bullish outside engulfing
            if (
                sl !== null &&
                sl === 0 &&
                curr.high > prev.high &&
                curr.close > prev.close &&
                curr.close > curr.open
            ) {
                return createBuySignal(cleanData, i, `Bullish outside engulfing fresh trap fade: fresh low, engulfed high, close > prev close`);
            }

            // Fresh high printed, but candle reverses into bearish outside engulfing
            if (
                sh !== null &&
                sh === 0 &&
                curr.low < prev.low &&
                curr.close < prev.close &&
                curr.close < curr.open
            ) {
                return createSellSignal(cleanData, i, `Bearish outside engulfing fresh trap fade: fresh high, engulfed low, close < prev close`);
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
