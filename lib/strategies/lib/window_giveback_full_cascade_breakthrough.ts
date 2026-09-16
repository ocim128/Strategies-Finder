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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 32))),
    };
}

export const window_giveback_full_cascade_breakthrough: Strategy = {
    name: "Window Giveback Full Cascade Breakthrough",
    description: "Enters trend reversal when >= 90% giveback is coupled with a benchmark price cross signaling complete prior trend failure.",
    defaultParams: {
        lookback: 32,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < lookback + 1) return null;
            const g = gb[i];
            if (g === null || g < 0.90) return null;

            if (closes[i - 1] <= closes[i - 1 - lookback] && closes[i] > closes[i - lookback]) {
                return createBuySignal(cleanData, i, `Bullish full cascade breakthrough: giveback ${g.toFixed(3)} >= 0.90, close flipped above prior benchmark`);
            }
            if (closes[i - 1] >= closes[i - 1 - lookback] && closes[i] < closes[i - lookback]) {
                return createSellSignal(cleanData, i, `Bearish full cascade breakthrough: giveback ${g.toFixed(3)} >= 0.90, close flipped below prior benchmark`);
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
