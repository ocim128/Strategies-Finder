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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const variance_ratio_expansion_flip: Strategy = {
    name: "Variance Ratio Expansion Flip",
    description: "Enters nascent trends when the Variance Ratio crosses above 1.15 in the direction of the 4-bar return.",
    defaultParams: {
        lookback: 30,
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
            const currentVr = vr[i];
            const prevVr = vr[i - 1];
            if (currentVr === null || prevVr === null) return null;

            if (prevVr <= 1.15 && currentVr > 1.15) {
                if (closes[i] > closes[i - 4]) {
                    return createBuySignal(cleanData, i, `Bullish VR expansion flip: VR ${prevVr.toFixed(3)} -> ${currentVr.toFixed(3)} > 1.15, close > close[i-4]`);
                }
                if (closes[i] < closes[i - 4]) {
                    return createSellSignal(cleanData, i, `Bearish VR expansion flip: VR ${prevVr.toFixed(3)} -> ${currentVr.toFixed(3)} > 1.15, close < close[i-4]`);
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
