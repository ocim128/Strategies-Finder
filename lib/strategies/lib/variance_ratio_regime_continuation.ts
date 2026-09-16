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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 24))),
    };
}

export const variance_ratio_regime_continuation: Strategy = {
    name: "Variance Ratio Regime Continuation",
    description: "Buys minor pullbacks and sells minor rallies when the Variance Ratio is locked in a strong superdiffusive regime (>1.25).",
    defaultParams: {
        lookback: 24,
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
            if (i < lookback) return null;
            const currentVr = vr[i];
            if (currentVr === null || currentVr <= 1.25) return null;

            // Uptrend continuation: window return positive, current bar is a down-close pullback dip
            if (closes[i] > closes[i - lookback] && cleanData[i].close < cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish VR regime dip buy: VR ${currentVr.toFixed(3)} > 1.25, uptrend, red pullback bar`);
            }

            // Downtrend continuation: window return negative, current bar is an up-close bounce rally
            if (closes[i] < closes[i - lookback] && cleanData[i].close > cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish VR regime bounce sell: VR ${currentVr.toFixed(3)} > 1.25, downtrend, green bounce bar`);
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
