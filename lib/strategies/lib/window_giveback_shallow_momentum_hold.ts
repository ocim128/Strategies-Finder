import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildWindowGivebackRatio,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const window_giveback_shallow_momentum_hold: Strategy = {
    name: "Window Giveback Shallow Momentum Hold",
    description: "Captures strong trend continuation when retracement giveback is contained to an ultra-shallow 0.236 Fibonacci hold.",
    defaultParams: {
        lookback: 20,
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

        const closes = getCloses(cleanData);
        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [gb, clsLoc], (i) => {
            if (i < lookback) return null;
            const g = gb[i];
            const loc = clsLoc[i];
            if (g === null || loc === null) return null;

            if (g >= 0.10 && g <= 0.236) {
                if (loc >= 0.80 && closes[i] > closes[i - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish shallow giveback hold: giveback ${g.toFixed(3)} in [0.10, 0.236], close location ${loc.toFixed(3)} >= 0.80, up-window`);
                }
                if (loc <= 0.20 && closes[i] < closes[i - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish shallow giveback hold: giveback ${g.toFixed(3)} in [0.10, 0.236], close location ${loc.toFixed(3)} <= 0.20, down-window`);
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
