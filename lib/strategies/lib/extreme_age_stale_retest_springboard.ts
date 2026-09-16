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
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 30))),
    };
}

export const extreme_age_stale_retest_springboard: Strategy = {
    name: "Extreme Age Stale Retest Springboard",
    description: "Enters trend leg when a broken stale ceiling or floor is validated as structural support on retest.",
    defaultParams: {
        lookback: 30,
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
            if (i < 2) return null;

            const shPrev2 = sinceHigh[i - 2];
            const shPrev1 = sinceHigh[i - 1];
            if (
                shPrev2 !== null &&
                shPrev2 >= lookback - 2 &&
                shPrev1 === 0 &&
                cleanData[i].low <= cleanData[i - 2].high &&
                cleanData[i].close > cleanData[i - 2].high
            ) {
                return createBuySignal(cleanData, i, `Bullish stale ceiling retest springboard: prior age=${shPrev2}>=${lookback - 2}, low<=breakout high, close>breakout high`);
            }

            const slPrev2 = sinceLow[i - 2];
            const slPrev1 = sinceLow[i - 1];
            if (
                slPrev2 !== null &&
                slPrev2 >= lookback - 2 &&
                slPrev1 === 0 &&
                cleanData[i].high >= cleanData[i - 2].low &&
                cleanData[i].close < cleanData[i - 2].low
            ) {
                return createSellSignal(cleanData, i, `Bearish stale floor retest springboard: prior age=${slPrev2}>=${lookback - 2}, high>=breakout low, close<breakout low`);
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
