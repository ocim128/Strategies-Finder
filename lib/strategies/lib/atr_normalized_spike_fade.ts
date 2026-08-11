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

const SPIKE_ATR_MULTIPLE = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 14))),
    };
}

export const atr_normalized_spike_fade: Strategy = {
    name: "ATR Normalized Spike Fade",
    description: "Fades single-bar jumps of at least two ATRs, sizing the spike against the ratio's own recent volatility.",
    defaultParams: {
        lookback: 14,
    },
    paramLabels: {
        lookback: "ATR Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);

        return createSignalLoop(cleanData, [atr], (i) => {
            const atrNow = atr[i];
            if (atrNow === null || atrNow <= 0) return null;

            const change = closes[i] - closes[i - 1];
            if (change <= -SPIKE_ATR_MULTIPLE * atrNow) {
                return createBuySignal(cleanData, i, `ATR spike fade buy: ${change.toFixed(4)} change at ${(change / atrNow).toFixed(2)} ATR`);
            }
            if (change >= SPIKE_ATR_MULTIPLE * atrNow) {
                return createSellSignal(cleanData, i, `ATR spike fade sell: ${change.toFixed(4)} change at ${(change / atrNow).toFixed(2)} ATR`);
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
