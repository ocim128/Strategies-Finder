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

export const sweep_reclaim_rest_bar_coiling: Strategy = {
    name: "Sweep Reclaim Rest Bar Coiling",
    description: "Enters trend resumption when an inside resting bar confirms supply/demand absorption following a liquidity sweep reclaim.",
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
        const min_score = p.min_score as number;
        if (cleanData.length < 2) return [];

        const sweep = buildSweepReclaimScoreSeries(cleanData);

        return createSignalLoop(cleanData, [sweep], (i) => {
            if (i < 1) return null;
            const prevScore = sweep[i - 1];
            if (prevScore === null) return null;

            const isInsideBar = cleanData[i].high <= cleanData[i - 1].high && cleanData[i].low >= cleanData[i - 1].low;
            if (!isInsideBar) return null;

            if (prevScore >= min_score && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish sweep rest coiling: prior sweep ${prevScore.toFixed(3)} >= ${min_score}, inside bull bar`);
            }
            if (prevScore <= -min_score && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish sweep rest coiling: prior sweep ${prevScore.toFixed(3)} <= -${min_score}, inside bear bar`);
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
