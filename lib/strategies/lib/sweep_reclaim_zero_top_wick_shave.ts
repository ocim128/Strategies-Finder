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

export const sweep_reclaim_zero_top_wick_shave: Strategy = {
    name: "Sweep Reclaim Zero Top Wick Shave",
    description: "Enters liquidity sweep reclaim when the bar closes virtually on its extreme tick with a shaved counter-wick.",
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
            const score = sweepScores[i];
            if (score === null) return null;

            const bar = cleanData[i];
            const range = bar.high - bar.low;
            if (range <= 0) return null;

            if (score >= minScore && (bar.high - bar.close) <= range * 0.05) {
                return createBuySignal(cleanData, i, `Bullish shaved-top sweep reclaim: score=${score.toFixed(2)}>=${minScore}, top wick<=${(range * 0.05).toFixed(4)}`);
            }
            if (score <= -minScore && (bar.close - bar.low) <= range * 0.05) {
                return createSellSignal(cleanData, i, `Bearish shaved-bottom sweep reclaim: score=${score.toFixed(2)}<=-${minScore}, bottom wick<=${(range * 0.05).toFixed(4)}`);
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
