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
        min_score: Math.max(0.05, Number(params.min_score ?? 0.25)),
    };
}

export const sweep_reclaim_higher_low_confirmation: Strategy = {
    name: "Sweep Reclaim Higher Low Confirmation",
    description: "Enters on structural two-bar confirmation where bar i holds a higher low and higher close following a sweep reclaim.",
    defaultParams: {
        min_score: 0.25,
    },
    paramLabels: {
        min_score: "Minimum Sweep Score",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const minScore = Number(params.min_score);

        const sweepScores = buildSweepReclaimScoreSeries(cleanData);

        return createSignalLoop(cleanData, [sweepScores], (i) => {
            if (i < 1) return null;
            const prevScore = sweepScores[i - 1];
            if (prevScore === null) return null;

            const curr = cleanData[i];
            const prev = cleanData[i - 1];

            if (prevScore >= minScore && curr.low > prev.low && curr.close > prev.close) {
                return createBuySignal(cleanData, i, `Bullish higher-low sweep confirmation: prevScore=${prevScore.toFixed(2)}>=${minScore}, low>prev.low, close>prev.close`);
            }
            if (prevScore <= -minScore && curr.high < prev.high && curr.close < prev.close) {
                return createSellSignal(cleanData, i, `Bearish lower-high sweep confirmation: prevScore=${prevScore.toFixed(2)}<=-${minScore}, high<prev.high, close<prev.close`);
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
