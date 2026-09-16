import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimScoreSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_score: Math.max(0.01, Number(params.min_score ?? 0.3)),
    };
}

export const sweep_reclaim_delayed_acceptance: Strategy = {
    name: "Sweep Reclaim Delayed Acceptance",
    description: "Confirms liquidity sweeps on bar i-1 with directional close acceptance beyond the prior extreme on bar i.",
    defaultParams: {
        min_score: 0.3,
    },
    paramLabels: {
        min_score: "Min Sweep Score",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const minScore = p.min_score as number;
        if (cleanData.length < 3) return [];

        const sweepScore = buildSweepReclaimScoreSeries(cleanData);

        return createSignalLoop(cleanData, [sweepScore], (i) => {
            if (i < 2) return null;
            const priorScore = sweepScore[i - 1];
            if (priorScore === null) return null;

            if (
                priorScore >= minScore &&
                cleanData[i].close > cleanData[i - 1].high &&
                cleanData[i].close > cleanData[i].open
            ) {
                return createBuySignal(cleanData, i, `Bullish delayed sweep acceptance: prior sweep ${priorScore.toFixed(3)} >= ${minScore}, close > prior high & bull body`);
            }

            if (
                priorScore <= -minScore &&
                cleanData[i].close < cleanData[i - 1].low &&
                cleanData[i].close < cleanData[i].open
            ) {
                return createSellSignal(cleanData, i, `Bearish delayed sweep acceptance: prior sweep ${priorScore.toFixed(3)} <= -${minScore}, close < prior low & bear body`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_score"],
    },
};
