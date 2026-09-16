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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 28))),
    };
}

export const window_giveback_golden_pocket_springboard: Strategy = {
    name: "Window Giveback Golden Pocket Springboard",
    description: "Captures trend continuation when excursion retracement strictly holds the 0.55-0.618 golden pocket boundary without breach.",
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

        const closes = getCloses(cleanData);
        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [gb, clsLoc], (i) => {
            if (i < lookback) return null;
            const g = gb[i];
            const loc = clsLoc[i];
            if (g === null || loc === null) return null;

            if (g >= 0.55 && g <= 0.618) {
                if (loc >= 0.70 && closes[i] > closes[i - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish golden pocket springboard: giveback ${g.toFixed(3)} in [0.55, 0.618], close location ${loc.toFixed(3)} >= 0.70, up-window`);
                }
                if (loc <= 0.30 && closes[i] < closes[i - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish golden pocket springboard: giveback ${g.toFixed(3)} in [0.55, 0.618], close location ${loc.toFixed(3)} <= 0.30, down-window`);
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
