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
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 28))),
    };
}

export const variance_ratio_term_crossover_impulse: Strategy = {
    name: "Variance Ratio Term Crossover Impulse",
    description: "Enters momentum impulse when 2-bar Variance Ratio crosses above 8-bar Variance Ratio in superdiffusive territory.",
    defaultParams: {
        lookback: 28,
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

        const vr2 = buildVarianceRatio(closes, lookback, 2);
        const vr8 = buildVarianceRatio(closes, lookback, 8);

        return createSignalLoop(cleanData, [vr2, vr8], (i) => {
            if (i < 1) return null;
            const v2Prev = vr2[i - 1];
            const v8Prev = vr8[i - 1];
            const v2Curr = vr2[i];
            const v8Curr = vr8[i];
            if (v2Prev === null || v8Prev === null || v2Curr === null || v8Curr === null) return null;

            if (v2Prev <= v8Prev && v2Curr > v8Curr && v2Curr > 1.05) {
                if (cleanData[i].close > cleanData[i - 1].high) {
                    return createBuySignal(cleanData, i, `Bullish VR term crossover impulse: VR2 crossed above VR8 (${v2Curr.toFixed(2)} > ${v8Curr.toFixed(2)}), close > high[i-1]`);
                }
                if (cleanData[i].close < cleanData[i - 1].low) {
                    return createSellSignal(cleanData, i, `Bearish VR term crossover impulse: VR2 crossed above VR8 (${v2Curr.toFixed(2)} > ${v8Curr.toFixed(2)}), close < low[i-1]`);
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
