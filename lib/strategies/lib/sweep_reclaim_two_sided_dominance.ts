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
        min_score: Math.max(0.05, Number(params.min_score ?? 0.30)),
    };
}

export const sweep_reclaim_two_sided_dominance: Strategy = {
    name: "Sweep Reclaim Two-Sided Dominance",
    description: "Enters winning direction when a two-sided expansion bar violating both extremes nets a decisive sweep reclaim score.",
    defaultParams: {
        min_score: 0.30,
    },
    paramLabels: {
        min_score: "Minimum Net Sweep Score",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const minScore = Number(params.min_score);

        const sweepScores = buildSweepReclaimScoreSeries(cleanData);

        return createSignalLoop(cleanData, [sweepScores], (i) => {
            if (i < 1) return null;
            const score = sweepScores[i];
            if (score === null) return null;

            const isTwoSided = cleanData[i].low < cleanData[i - 1].low && cleanData[i].high > cleanData[i - 1].high;
            if (isTwoSided) {
                if (score >= minScore) {
                    return createBuySignal(cleanData, i, `Bullish two-sided dominance: dual breach, net score=${score.toFixed(2)}>=${minScore}`);
                }
                if (score <= -minScore) {
                    return createSellSignal(cleanData, i, `Bearish two-sided dominance: dual breach, net score=${score.toFixed(2)}<=-${minScore}`);
                }
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
