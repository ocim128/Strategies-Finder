import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildVarianceRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 28))),
    };
}

export const variance_ratio_subdiffusive_entry_flip: Strategy = {
    name: "Variance Ratio Subdiffusive Entry Flip",
    description: "Enters mean-reverting positions when the Variance Ratio flips below 0.80 into a subdiffusive regime.",
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
        if (cleanData.length < lookback + 4) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, lookback, 4);

        return createSignalLoop(cleanData, [vr], (i) => {
            if (i < 4) return null;
            const prevVr = vr[i - 1];
            const currVr = vr[i];
            if (prevVr === null || currVr === null) return null;

            if (prevVr >= 0.80 && currVr < 0.80) {
                if (closes[i] < closes[i - 4]) {
                    return createBuySignal(cleanData, i, `Bullish subdiffusive flip: VR fell from ${prevVr.toFixed(3)} to ${currVr.toFixed(3)} < 0.80, 4-bar return negative`);
                }
                if (closes[i] > closes[i - 4]) {
                    return createSellSignal(cleanData, i, `Bearish subdiffusive flip: VR fell from ${prevVr.toFixed(3)} to ${currVr.toFixed(3)} < 0.80, 4-bar return positive`);
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
