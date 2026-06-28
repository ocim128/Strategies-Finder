import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingZScore, buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        zThreshold: Math.max(0.5, Number(params.zThreshold ?? 1.3)),
        efficiencyMax: Math.max(0.05, Math.min(0.9, Number(params.efficiencyMax ?? 0.30))),
    };
}

export const efficient_mean_reversion: Strategy = {
    name: "Efficient Mean Reversion",
    description: "Reverts extreme z-score stretches only when efficiency is low, ensuring high win rate by fading noisy stretches.",
    defaultParams: {
        lookback: 25,
        zThreshold: 1.3,
        efficiencyMax: 0.30,
    },
    paramLabels: {
        lookback: "Lookback",
        zThreshold: "Z-Score Threshold",
        efficiencyMax: "Max Efficiency",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const zscore = buildRollingZScore(closes, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [zscore, efficiency], (i) => {
            const z = zscore[i];
            const er = efficiency[i];
            if (z === null || er === null) return null;
            if (er >= (p.efficiencyMax as number)) return null;

            const zThresh = p.zThreshold as number;
            if (z < -zThresh) {
                return createBuySignal(cleanData, i, `Eff MR z ${z.toFixed(2)} eff ${er.toFixed(2)} noisy stretch buy`);
            }
            if (z > zThresh) {
                return createSellSignal(cleanData, i, `Eff MR z ${z.toFixed(2)} eff ${er.toFixed(2)} noisy stretch sell`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold", "efficiencyMax"],
    },
};
