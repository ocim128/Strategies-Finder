import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
        pctlExtreme: Math.max(0, Math.min(1, Number(params.pctlExtreme ?? 0.90))),
    };
}

export const rolling_median_percentile_rank_reversion: Strategy = {
    name: "Rolling Median Percentile Rank Reversion",
    description: "Fades extreme deviations from the rolling median using percentile rank.",
    defaultParams: {
        lookback: 40,
        pctlExtreme: 0.90,
    },
    paramLabels: {
        lookback: "Lookback Window",
        pctlExtreme: "Percentile Extreme",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);

        const distances: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            distances[i] = m !== null ? Math.abs(closes[i] - m) : 0;
        }

        const percentile = buildPercentileRank(distances, lookback);

        return createSignalLoop(cleanData, [median, percentile], (i) => {
            const m = median[i];
            const pRank = percentile[i];
            if (m === null || pRank === null) return null;

            const close = closes[i];

            if (pRank > p.pctlExtreme) {
                if (close < m) {
                    return createBuySignal(cleanData, i, `Rolling median percentile buy: rank ${pRank.toFixed(2)} with close < median`);
                }
                if (close > m) {
                    return createSellSignal(cleanData, i, `Rolling median percentile sell: rank ${pRank.toFixed(2)} with close > median`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pctlExtreme"],
    },
};
