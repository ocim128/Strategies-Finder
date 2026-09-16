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
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 32))),
    };
}

export const extreme_age_stale_break_runaway_step: Strategy = {
    name: "Extreme Age Stale Break Runaway Step",
    description: "Enters post-stale breakout expansion when bar i closes beyond the breakout bar's extreme with zero pullback friction.",
    defaultParams: {
        lookback: 32,
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
                cleanData[i].close > cleanData[i - 1].high
            ) {
                return createBuySignal(cleanData, i, `Bullish stale break runaway step: stale high breached at i-1, bar i close > breakout high`);
            }

            const slPrev2 = sinceLow[i - 2];
            const slPrev1 = sinceLow[i - 1];
            if (
                slPrev2 !== null &&
                slPrev2 >= lookback - 2 &&
                slPrev1 === 0 &&
                cleanData[i].close < cleanData[i - 1].low
            ) {
                return createSellSignal(cleanData, i, `Bearish stale break runaway step: stale low breached at i-1, bar i close < breakout low`);
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
