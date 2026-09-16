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
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 26))),
    };
}

export const window_giveback_deep_fib_last_stand: Strategy = {
    name: "Window Giveback Deep Fib Last Stand",
    description: "Enters recovery when excursion giveback defense holds at the deep 0.618–0.786 Fibonacci boundary with perimeter close location.",
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
        const closes = getCloses(cleanData);

        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [gb, clsLoc], (i) => {
            if (i < lookback) return null;
            const g = gb[i];
            const loc = clsLoc[i];
            if (g === null || loc === null) return null;

            if (g >= 0.618 && g <= 0.786) {
                if (loc >= 0.80 && closes[i] > closes[i - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish deep fib last stand: giveback=${g.toFixed(3)} in [0.618,0.786], closeLoc=${loc.toFixed(2)}>=0.80`);
                }
                if (loc <= 0.20 && closes[i] < closes[i - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish deep fib last stand: giveback=${g.toFixed(3)} in [0.618,0.786], closeLoc=${loc.toFixed(2)}<=0.20`);
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
