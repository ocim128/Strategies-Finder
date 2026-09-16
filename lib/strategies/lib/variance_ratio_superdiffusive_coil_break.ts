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
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 26))),
    };
}

export const variance_ratio_superdiffusive_coil_break: Strategy = {
    name: "Variance Ratio Superdiffusive Coil Break",
    description: "Enters trend continuation when price breaks out of a 2-bar compression coil during a certified superdiffusive trend.",
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

        const vr = buildVarianceRatio(closes, lookback, 4);

        return createSignalLoop(cleanData, [vr], (i) => {
            if (i < 2 || i < lookback) return null;
            const v = vr[i];
            if (v === null || v < 1.20) return null;

            const rangePrev1 = cleanData[i - 1].high - cleanData[i - 1].low;
            const rangePrev2 = cleanData[i - 2].high - cleanData[i - 2].low;

            if (rangePrev1 < rangePrev2) {
                if (cleanData[i].close > cleanData[i - 1].high && closes[i] > closes[i - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish superdiffusive coil break: VR=${v.toFixed(2)}>=1.20, range contracted at i-1, breakout up`);
                }
                if (cleanData[i].close < cleanData[i - 1].low && closes[i] < closes[i - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish superdiffusive coil break: VR=${v.toFixed(2)}>=1.20, range contracted at i-1, breakout down`);
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
