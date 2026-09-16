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
        min_score: Math.max(0.01, Number(params.min_score ?? 0.25)),
    };
}

export const sweep_reclaim_gap_acceleration_step: Strategy = {
    name: "Sweep Reclaim Gap Acceleration Step",
    description: "Enters in the direction of an open gap that immediately follows a liquidity sweep reclaim.",
    defaultParams: {
        min_score: 0.25,
    },
    paramLabels: {
        min_score: "Min Sweep Score",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const minScore = p.min_score as number;
        if (cleanData.length < 2) return [];

        const sweepScore = buildSweepReclaimScoreSeries(cleanData);

        return createSignalLoop(cleanData, [sweepScore], (i) => {
            if (i < 1) return null;
            const priorScore = sweepScore[i - 1];

            if (
                priorScore >= minScore &&
                cleanData[i].open > cleanData[i - 1].close &&
                cleanData[i].close > cleanData[i].open
            ) {
                return createBuySignal(cleanData, i, `Bullish sweep gap acceleration: prior sweep ${priorScore.toFixed(3)} >= ${minScore}, open gap-up and bull close`);
            }

            if (
                priorScore <= -minScore &&
                cleanData[i].open < cleanData[i - 1].close &&
                cleanData[i].close < cleanData[i].open
            ) {
                return createSellSignal(cleanData, i, `Bearish sweep gap acceleration: prior sweep ${priorScore.toFixed(3)} <= -${minScore}, open gap-down and bear close`);
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
