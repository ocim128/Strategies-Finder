import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming strong shift in initiative pressure percentile rank precedes a sustained trend.
// #SUGGEST_VERIFY: Verify percentile threshold (0.5 to 0.99) is robust to WFA sweeps.
function normalizeParams(params: StrategyParams): StrategyParams {
    const rawThreshold = Number(params.threshold ?? 80);
    const normalizedThreshold = rawThreshold > 1 ? rawThreshold / 100 : rawThreshold;
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        threshold: Math.max(0.5, Math.min(0.99, normalizedThreshold)),
    };
}

export const initiative_pressure_distribution_shift: Strategy = {
    name: "Initiative Pressure Distribution Shift",
    description: "Identifies momentum breakouts when the rolling percentile rank of initiative pressure exceeds extreme levels.",
    defaultParams: {
        lookback: 30,
        threshold: 0.80,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Percentile Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const threshold = p.threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        // Sanitize pressure nulls to 0
        const sanitizedPressure = pressure.map(v => v ?? 0);
        const pressurePercentiles = buildPercentileRank(sanitizedPressure, lookback);

        return createSignalLoop(cleanData, [pressurePercentiles], (i) => {
            const pct = pressurePercentiles[i];
            const pres = pressure[i];
            if (pct === null || pres === null) return null;

            // Buy: percentile is extreme high, pressure is positive (aggressive buyers in control)
            if (pct > threshold && pres > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish momentum: initiative pressure percentile ${(pct * 100).toFixed(0)}% > ${(threshold * 100).toFixed(0)}%`
                );
            }

            // Sell: percentile is extreme low, pressure is negative (aggressive sellers in control)
            if (pct < 1.0 - threshold && pres < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish momentum: initiative pressure percentile ${(pct * 100).toFixed(0)}% < ${((1 - threshold) * 100).toFixed(0)}%`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold"],
    },
};
