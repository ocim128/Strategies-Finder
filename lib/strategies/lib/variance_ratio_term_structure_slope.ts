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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 32))),
    };
}

export const variance_ratio_term_structure_slope: Strategy = {
    name: "Variance Ratio Term Structure Slope",
    description: "Enters multi-scale trending moves when the Variance Ratio term structure slope (VR8 - VR2) exceeds 0.20.",
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
        if (cleanData.length < lookback + 8) return [];

        const closes = getCloses(cleanData);
        const vr2 = buildVarianceRatio(closes, lookback, 2);
        const vr8 = buildVarianceRatio(closes, lookback, 8);

        return createSignalLoop(cleanData, [vr2, vr8], (i) => {
            if (i < 8) return null;
            const v2 = vr2[i];
            const v8 = vr8[i];
            if (v2 === null || v8 === null) return null;

            const slope = v8 - v2;
            if (slope > 0.20) {
                if (closes[i] > closes[i - 8]) {
                    return createBuySignal(cleanData, i, `Bullish VR term structure slope: VR(8)-VR(2) ${slope.toFixed(3)} > 0.20, close > close[i-8]`);
                }
                if (closes[i] < closes[i - 8]) {
                    return createSellSignal(cleanData, i, `Bearish VR term structure slope: VR(8)-VR(2) ${slope.toFixed(3)} > 0.20, close < close[i-8]`);
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
