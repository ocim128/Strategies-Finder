import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        maxWickPercentile: Math.max(0.01, Math.min(0.99, Number(params.maxWickPercentile ?? 0.35))),
        rocZThreshold: Math.max(0.01, Number(params.rocZThreshold ?? 1.7)),
    };
}

export const wick_imbalance_thrust_continuation: Strategy = {
    name: "Wick Imbalance Thrust Continuation",
    description: "Follows breakouts when price ROC z-score is extreme and absolute wick imbalance percentile rank is low (solid body with no rejection).",
    defaultParams: {
        lookback: 30,
        maxWickPercentile: 0.35,
        rocZThreshold: 1.7,
    },
    paramLabels: {
        lookback: "Lookback Window",
        maxWickPercentile: "Max Wick Percentile",
        rocZThreshold: "ROC Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const returnsClean = closeReturn.map((v) => v ?? 0);

        const rocZ = buildRollingZScore(returnsClean, lookback);

        const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        const absWickImbalance = wickImbalance.map((v) => Math.abs(v));
        const wickPct = buildPercentileRank(absWickImbalance, lookback);

        return createSignalLoop(cleanData, [rocZ, wickPct], (i) => {
            const rz = rocZ[i];
            const wp = wickPct[i];
            if (rz === null || wp === null) return null;

            // Buy: return z-score is extremely positive (upside breakout), wick imbalance is low
            if (rz > p.rocZThreshold && wp < p.maxWickPercentile) {
                return createBuySignal(cleanData, i, `Wick imbalance thrust buy: ROC Z ${rz.toFixed(2)}, Wick Pct ${wp.toFixed(2)}`);
            }
            // Sell: return z-score is extremely negative (downside breakdown), wick imbalance is low
            if (rz < -p.rocZThreshold && wp < p.maxWickPercentile) {
                return createSellSignal(cleanData, i, `Wick imbalance thrust sell: ROC Z ${rz.toFixed(2)}, Wick Pct ${wp.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxWickPercentile", "rocZThreshold"],
    },
};
