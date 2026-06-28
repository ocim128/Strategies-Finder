import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        zThreshold: Math.max(0.5, Number(params.zThreshold ?? 1.5)),
    };
}

export const midpoint_close_deviation_persistence: Strategy = {
    name: "Midpoint Close Deviation Persistence",
    description: "Follows persistent directional pressure when close-to-midpoint deviation z-score is stretched with acceptance.",
    defaultParams: {
        lookback: 30,
        zThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        // Per-bar deviation: (close - midpoint) / range
        const deviation = closes.map((c, i) => {
            const range = highs[i] - lows[i];
            if (range <= 0) return 0;
            const mid = (highs[i] + lows[i]) / 2;
            return (c - mid) / range;
        });

        const zscore = buildRollingZScore(deviation, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [zscore], (i) => {
            const z = zscore[i];
            if (z === null) return null;

            const zThresh = p.zThreshold as number;
            const ca = closeAcceptance[i];

            if (z > zThresh && ca > 0) {
                return createBuySignal(cleanData, i, `Midpoint dev z ${z.toFixed(2)} bullish acceptance`);
            }
            if (z < -zThresh && ca < 0) {
                return createSellSignal(cleanData, i, `Midpoint dev z ${z.toFixed(2)} bearish acceptance`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
