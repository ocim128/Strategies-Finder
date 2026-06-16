import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildEfficiencyRatio,
    buildRollingZScore,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        maxEfficiency: Math.max(0, Math.min(1, Number(params.maxEfficiency ?? 0.25))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.8)),
    };
}

export const inefficient_stretch_reversion: Strategy = {
    name: "Inefficient Stretch Reversion",
    description: "Fades return z-score extremes when rolling efficiency ratio is low.",
    defaultParams: {
        lookback: 30,
        maxEfficiency: 0.25,
        zThreshold: 1.8,
    },
    paramLabels: {
        lookback: "Lookback Window",
        maxEfficiency: "Max Efficiency",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const returnZ = buildRollingZScore(returns, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [returnZ, efficiency], (i) => {
            const z = returnZ[i];
            const er = efficiency[i];
            if (z === null || er === null) return null;

            if (er < p.maxEfficiency) {
                // Buy: return z-score is below -zThreshold and efficiency is low -> long reversion
                if (z < -p.zThreshold) {
                    return createBuySignal(cleanData, i, `Inefficient stretch buy: Z-score ${z.toFixed(2)}, ER ${er.toFixed(2)}`);
                }
                // Sell: return z-score is above zThreshold and efficiency is low -> short reversion
                if (z > p.zThreshold) {
                    return createSellSignal(cleanData, i, `Inefficient stretch sell: Z-score ${z.toFixed(2)}, ER ${er.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxEfficiency", "zThreshold"],
    },
};
