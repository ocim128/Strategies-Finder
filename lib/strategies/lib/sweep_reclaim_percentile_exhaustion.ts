import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimScoreSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const sweep_reclaim_percentile_exhaustion: Strategy = {
    name: "Sweep Reclaim Percentile Exhaustion",
    description: "Fades statistical tail liquidity sweeps where the rolling percentile rank of sweep score reaches extreme quantiles.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const sweep = buildSweepReclaimScoreSeries(cleanData);
        const pctRank = buildPercentileRank(sweep, lookback);

        return createSignalLoop(cleanData, [pctRank], (i) => {
            const pr = pctRank[i];
            const score = sweep[i];
            if (pr === null) return null;

            if (pr >= 0.95 && score > 0) {
                return createBuySignal(cleanData, i, `Bullish sweep percentile exhaustion: pctl ${pr.toFixed(2)} >= 0.95, score ${score.toFixed(3)} > 0`);
            }
            if (pr <= 0.05 && score < 0) {
                return createSellSignal(cleanData, i, `Bearish sweep percentile exhaustion: pctl ${pr.toFixed(2)} <= 0.05, score ${score.toFixed(3)} < 0`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
