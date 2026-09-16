import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildRangeSeries,
    buildRollingAverage,
    buildSweepReclaimScoreSeries,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const sweep_reclaim_compression_gate: Strategy = {
    name: "Sweep Reclaim Compression Gate",
    description: "Enters liquidity sweep reclaims occurring during quiet volatility compression bars.",
    defaultParams: {
        lookback: 20,
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
        const range = buildRangeSeries(cleanData);
        const avgRange = buildRollingAverage(range, lookback);

        return createSignalLoop(cleanData, [sweep, avgRange], (i) => {
            const score = sweep[i];
            const avg = avgRange[i];
            if (score === null || avg === null) return null;

            const barRange = cleanData[i].high - cleanData[i].low;
            if (barRange < avg * 0.75) {
                if (score >= 0.20) {
                    return createBuySignal(cleanData, i, `Bullish compression sweep: spring score ${score.toFixed(3)} >= 0.20, bar range ${barRange.toFixed(4)} < 0.75 * avg range`);
                }
                if (score <= -0.20) {
                    return createSellSignal(cleanData, i, `Bearish compression sweep: upthrust score ${score.toFixed(3)} <= -0.20, bar range ${barRange.toFixed(4)} < 0.75 * avg range`);
                }
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
