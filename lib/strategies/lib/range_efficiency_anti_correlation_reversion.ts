import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingCorrelation, buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        correlationMax: Math.max(-0.95, Math.min(0, Number(params.correlationMax ?? -0.15))),
        returnZThreshold: Math.max(0.5, Number(params.returnZThreshold ?? 1.5)),
    };
}

export const range_efficiency_anti_correlation_reversion: Strategy = {
    name: "Range Efficiency Anti-Correlation Reversion",
    description: "Reverts stretched ratios when range-efficiency anti-correlation confirms a mean-reverting regime with no directional conviction.",
    defaultParams: {
        lookback: 30,
        correlationMax: -0.15,
        returnZThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        correlationMax: "Max Correlation",
        returnZThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const ranges = buildRangeSeries(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const effClean = efficiency.map(v => v ?? 0);
        const corr = buildRollingCorrelation(ranges, effClean, lookback);
        const zscore = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [corr, zscore], (i) => {
            const c = corr[i];
            const z = zscore[i];
            if (c === null || z === null) return null;
            if (c >= (p.correlationMax as number)) return null;

            const zThresh = p.returnZThreshold as number;
            if (z < -zThresh) {
                return createBuySignal(cleanData, i, `Range-eff anti-corr ${c.toFixed(2)} z-score ${z.toFixed(2)} reversion buy`);
            }
            if (z > zThresh) {
                return createSellSignal(cleanData, i, `Range-eff anti-corr ${c.toFixed(2)} z-score ${z.toFixed(2)} reversion sell`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "correlationMax", "returnZThreshold"],
    },
};
