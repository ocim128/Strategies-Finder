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

export const variance_ratio_bifurcation_crossover: Strategy = {
    name: "Variance Ratio Bifurcation Crossover",
    description: "Enters trend persistence when the Variance Ratio crosses above the theoretical 1.00 phase bifurcation threshold.",
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
        if (cleanData.length < lookback + 4) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, lookback, 4);

        return createSignalLoop(cleanData, [vr], (i) => {
            if (i < 1) return null;
            const prevVr = vr[i - 1];
            const currVr = vr[i];
            if (prevVr === null || currVr === null) return null;

            if (prevVr < 1.00 && currVr >= 1.00) {
                if (cleanData[i].close > cleanData[i - 1].high) {
                    return createBuySignal(cleanData, i, `Bullish bifurcation crossover: VR crossed above 1.00 (${prevVr.toFixed(3)} -> ${currVr.toFixed(3)}), close > prior high`);
                }
                if (cleanData[i].close < cleanData[i - 1].low) {
                    return createSellSignal(cleanData, i, `Bearish bifurcation crossover: VR crossed above 1.00 (${prevVr.toFixed(3)} -> ${currVr.toFixed(3)}), close < prior low`);
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
