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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.9)),
        maxEfficiency: Math.max(0, Math.min(1, Number(params.maxEfficiency ?? 0.30))),
    };
}

export const efficiency_gated_reversion: Strategy = {
    name: "Efficiency Gated Reversion",
    description: "Fades close return z-score extremes only when rolling efficiency ratio is below maxEfficiency.",
    defaultParams: {
        lookback: 25,
        zThreshold: 1.9,
        maxEfficiency: 0.30,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
        maxEfficiency: "Max Efficiency",
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
                if (z < -p.zThreshold) {
                    return createBuySignal(cleanData, i, `Efficiency gated reversion buy: Z ${z.toFixed(2)}, ER ${er.toFixed(2)}`);
                }
                if (z > p.zThreshold) {
                    return createSellSignal(cleanData, i, `Efficiency gated reversion sell: Z ${z.toFixed(2)}, ER ${er.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold", "maxEfficiency"],
    },
};
