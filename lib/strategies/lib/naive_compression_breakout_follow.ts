import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange, buildRollingStdDev, buildRollingZScore } from "./price-action-statistics-core";

function normalizeNaiveCompressionBreakoutFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        volPercentileMax: Math.max(0, Math.min(1, Number(params.volPercentileMax ?? 0.25))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.5)),
    };
}

export const naive_compression_breakout_follow: Strategy = {
    name: "Naive Compression Breakout Follow",
    description: "Volatility compression breakout without quality gates.",
    defaultParams: {
        lookback: 30,
        volPercentileMax: 0.25,
        zThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        volPercentileMax: "Vol Percentile Max",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams: normalizeNaiveCompressionBreakoutFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeNaiveCompressionBreakoutFollowParams(params);
        const lookback = p.lookback as number;
        const volPercentileMax = p.volPercentileMax as number;
        const zThreshold = p.zThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const volatility = buildRollingStdDev(cleanReturns, lookback);
        const cleanVolatility = volatility.map(v => v ?? 0);
        const volPercentile = buildPercentileRank(cleanVolatility, lookback);
        const zscore = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [volPercentile, zscore], (i) => {
            const volPct = volPercentile[i];
            const z = zscore[i];
            if (volPct === null || z === null) return null;

            if (volPct < volPercentileMax && z > zThreshold) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Compression breakout buy: vol percentile ${volPct.toFixed(2)}, zscore ${z.toFixed(2)}`
                );
            }
            if (volPct < volPercentileMax && z < -zThreshold) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Compression breakout sell: vol percentile ${volPct.toFixed(2)}, zscore ${z.toFixed(2)}`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volPercentileMax", "zThreshold"],
    },
};
