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

export const window_giveback_fib_continuation: Strategy = {
    name: "Window Giveback Fib Continuation",
    description: "Trades trend continuation when the giveback ratio crosses back below 0.382 after testing the 0.382-0.618 pullback zone.",
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
        if (cleanData.length < lookback + 1) return [];

        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < lookback) return null;
            const currentGb = gb[i];
            const prevGb = gb[i - 1];
            if (currentGb === null || prevGb === null) return null;

            if (prevGb >= 0.382 && prevGb <= 0.618 && currentGb < 0.382) {
                if (closes[i] > closes[i - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish Fib continuation: giveback ${prevGb.toFixed(3)} -> ${currentGb.toFixed(3)} < 0.382, close > close[i-${lookback}]`);
                }
                if (closes[i] < closes[i - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish Fib continuation: giveback ${prevGb.toFixed(3)} -> ${currentGb.toFixed(3)} < 0.382, close < close[i-${lookback}]`);
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
