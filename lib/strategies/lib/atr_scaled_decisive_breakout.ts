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
import { calculateATR } from "../indicators";
import { buildTrailingHighLow } from "./price-action-frequency-core";

const ATR_FRACTION_THRESHOLD = 0.5;

function normalizeAtrScaledDecisiveBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const atr_scaled_decisive_breakout: Strategy = {
    name: "ATR Scaled Decisive Breakout",
    description: "Trades closes that clear the prior-only trailing high/low by at least half an ATR, scaling decisiveness by volatility.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeAtrScaledDecisiveBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeAtrScaledDecisiveBreakoutParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);

        return createSignalLoop(cleanData, [highest, lowest, atr], (i) => {
            if (i < lookback) return null;
            const highBound = highest[i];
            const lowBound = lowest[i];
            const atrNow = atr[i];
            if (highBound === null || lowBound === null || atrNow === null || atrNow <= 0) return null;

            if ((closes[i] - highBound) / atrNow > ATR_FRACTION_THRESHOLD) {
                return createBuySignal(cleanData, i, `ATR decisive breakout buy: close ${((closes[i] - highBound) / atrNow).toFixed(2)} ATRs above trailing high`);
            }
            if ((lowBound - closes[i]) / atrNow > ATR_FRACTION_THRESHOLD) {
                return createSellSignal(cleanData, i, `ATR decisive breakout sell: close ${((lowBound - closes[i]) / atrNow).toFixed(2)} ATRs below trailing low`);
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
