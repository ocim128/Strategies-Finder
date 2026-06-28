import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        efficiencyMax: Math.max(0.05, Math.min(0.5, Number(params.efficiencyMax ?? 0.25))),
        returnZThreshold: Math.max(0.5, Number(params.returnZThreshold ?? 1.5)),
    };
}

export const efficiency_collapse_return_reversion: Strategy = {
    name: "Efficiency Collapse Return Reversion",
    description: "Reverts stretched ratios when efficiency collapses, confirming directional conviction has evaporated.",
    defaultParams: {
        lookback: 30,
        efficiencyMax: 0.25,
        returnZThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        efficiencyMax: "Max Efficiency",
        returnZThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const zscore = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [efficiency, zscore], (i) => {
            const er = efficiency[i];
            const z = zscore[i];
            if (er === null || z === null) return null;
            if (er >= (p.efficiencyMax as number)) return null;

            const zThresh = p.returnZThreshold as number;
            // Buy: stretched down with no directional conviction
            if (z < -zThresh) {
                return createBuySignal(cleanData, i, `Eff collapse ${er.toFixed(2)} z-score ${z.toFixed(2)} reversion buy`);
            }
            // Sell: stretched up with no directional conviction
            if (z > zThresh) {
                return createSellSignal(cleanData, i, `Eff collapse ${er.toFixed(2)} z-score ${z.toFixed(2)} reversion sell`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "efficiencyMax", "returnZThreshold"],
    },
};
