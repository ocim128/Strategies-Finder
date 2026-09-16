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
        micro_max: Math.max(0.005, Number(params.micro_max ?? 0.05)),
    };
}

export const sweep_reclaim_micro_probe_exhaustion: Strategy = {
    name: "Sweep Reclaim Micro Probe Exhaustion",
    description: "Enters reversal when a sweep-reclaim probe is microscopic, indicating total exhaustion of counter-trend liquidity.",
    defaultParams: {
        micro_max: 0.05,
    },
    paramLabels: {
        micro_max: "Micro Probe Threshold",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const microMax = Number(params.micro_max);

        const sweepScores = buildSweepReclaimScoreSeries(cleanData);

        return createSignalLoop(cleanData, [sweepScores], (i) => {
            const score = sweepScores[i];
            if (score === null) return null;

            if (score > 0 && score <= microMax && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish micro probe exhaustion: sweepScore=${score.toFixed(3)}<=${microMax}, close>open`);
            }
            if (score < 0 && score >= -microMax && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish micro probe exhaustion: sweepScore=${score.toFixed(3)}>=-${microMax}, close<open`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["micro_max"],
    },
};
