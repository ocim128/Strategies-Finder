import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildExtremeAgeSeries,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 24))),
    };
}

export const extreme_age_compression_glide: Strategy = {
    name: "Extreme Age Compression Glide",
    description: "Enters breakout continuation when price glides along a freshly printed extreme with persistent outer close location.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [closeLocation], (i) => {
            const sh = sinceHigh[i];
            const sl = sinceLow[i];
            const cl = closeLocation[i];
            if (sh === null || sl === null || cl === null) return null;

            // Buy: Fresh high within 2 bars, close in upper 20%, bull bar
            if (sh <= 2 && cl >= 0.80 && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish compression glide: sinceHigh ${sh} <= 2, closeLocation ${cl.toFixed(2)} >= 0.80, bull close`);
            }

            // Sell: Fresh low within 2 bars, close in lower 20%, bear bar
            if (sl <= 2 && cl <= 0.20 && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish compression glide: sinceLow ${sl} <= 2, closeLocation ${cl.toFixed(2)} <= 0.20, bear close`);
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
