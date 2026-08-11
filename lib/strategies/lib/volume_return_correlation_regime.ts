import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import {
    buildPercentileRank,
    buildRateOfChange,
    buildRollingCorrelation,
} from "./price-action-statistics-core";

const CORRELATION_BAND = 0.4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const volume_return_correlation_regime: Strategy = {
    name: "Volume Return Correlation Regime",
    description: "Enters when the rolling correlation between signed returns and relative volume flips decisively positive or negative.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Regime Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback * 2) return [];

        const returns = buildRateOfChange(getCloses(cleanData), 1).map((v) => (v === null ? 0 : v));
        const volumeRank = buildPercentileRank(getVolumes(cleanData), lookback).map((v) => (v === null ? 0 : v));
        const correlation = buildRollingCorrelation(returns, volumeRank, lookback);
        // The volume-rank warm-up nulls are coerced, so the correlation window is
        // fully real only one lookback later than its first output.
        const firstValid = lookback * 2 - 1;

        return createSignalLoop(cleanData, [correlation], (i) => {
            if (i < firstValid) return null;
            const prev = correlation[i - 1];
            const curr = correlation[i];
            if (prev === null || curr === null || !Number.isFinite(prev) || !Number.isFinite(curr)) return null;

            // Participation regime crosses to supporting up moves.
            if (prev < CORRELATION_BAND && curr >= CORRELATION_BAND) {
                return createBuySignal(cleanData, i, `Volume-return regime buy: correlation ${curr.toFixed(2)} crossed above band`);
            }
            // Participation regime crosses to supporting down moves.
            if (prev > -CORRELATION_BAND && curr <= -CORRELATION_BAND) {
                return createSellSignal(cleanData, i, `Volume-return regime sell: correlation ${curr.toFixed(2)} crossed below band`);
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
