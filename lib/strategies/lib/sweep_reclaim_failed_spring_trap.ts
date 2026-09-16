import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildSweepReclaimScoreSeries,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_score: Math.max(0.01, Number(params.min_score ?? 0.3)),
    };
}

export const sweep_reclaim_failed_spring_trap: Strategy = {
    name: "Sweep Reclaim Failed Spring Trap",
    description: "Enters continuation breakout when a sweep-reclaim spring or upthrust immediately fails and closes through.",
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
        const min_score = p.min_score as number;
        if (cleanData.length < 2) return [];

        const sweep = buildSweepReclaimScoreSeries(cleanData);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [sweep, clsLoc], (i) => {
            const score = sweep[i];
            const loc = clsLoc[i];
            if (score === null || loc === null) return null;

            if (score <= -min_score && loc >= 0.65) {
                return createBuySignal(cleanData, i, `Bullish failed upthrust trap: sweep score ${score.toFixed(3)} <= -${min_score} with strong close location ${loc.toFixed(3)} >= 0.65`);
            }
            if (score >= min_score && loc <= 0.35) {
                return createSellSignal(cleanData, i, `Bearish failed spring trap: sweep score ${score.toFixed(3)} >= ${min_score} with weak close location ${loc.toFixed(3)} <= 0.35`);
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
