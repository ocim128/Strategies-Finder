import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildWindowGivebackRatio } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 28))),
    };
}

export const window_giveback_round_trip_reversal: Strategy = {
    name: "Window Giveback Round Trip Reversal",
    description: "Enters mean-reversion bounces when a move surrenders 90%+ of its window excursion back to its origin anchor.",
    defaultParams: {
        lookback: 28,
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

        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < lookback) return null;
            const currentGb = gb[i];
            if (currentGb === null || currentGb < 0.90) return null;

            // Up-window round trip: started lower, surged, then fell back 90%+ to origin anchor with bull close
            if (closes[i] >= closes[i - lookback] && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish round-trip reversal: giveback ${currentGb.toFixed(2)} >= 0.90 in up-window, bull close`);
            }

            // Down-window round trip: started higher, plunged, then rallied back 90%+ to origin anchor with bear close
            if (closes[i] < closes[i - lookback] && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish round-trip reversal: giveback ${currentGb.toFixed(2)} >= 0.90 in down-window, bear close`);
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
