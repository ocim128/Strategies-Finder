import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildExtremeAgeSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 36))),
    };
}

export const extreme_age_stale_boundary_breach: Strategy = {
    name: "Extreme Age Stale Boundary Breach",
    description: "Enters breakout expansion when a longstanding, aged price boundary (sinceExtreme >= lookback - 2) is breached.",
    defaultParams: {
        lookback: 36,
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

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, lookback);
        const staleThreshold = lookback - 2;

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            const prevSh = sinceHigh[i - 1];
            const currSh = sinceHigh[i];
            const prevSl = sinceLow[i - 1];
            const currSl = sinceLow[i];

            // Buy: Ceiling was stale (>= lookback - 2), freshly breached on bar i (age 0), close > prior high
            if (prevSh !== null && prevSh >= staleThreshold && currSh === 0 && cleanData[i].close > cleanData[i - 1].high) {
                return createBuySignal(cleanData, i, `Bullish stale ceiling breach: prior sinceHigh ${prevSh} >= ${staleThreshold}, sinceHigh 0, close > prior high`);
            }

            // Sell: Floor was stale (>= lookback - 2), freshly breached on bar i (age 0), close < prior low
            if (prevSl !== null && prevSl >= staleThreshold && currSl === 0 && cleanData[i].close < cleanData[i - 1].low) {
                return createSellSignal(cleanData, i, `Bearish stale floor breach: prior sinceLow ${prevSl} >= ${staleThreshold}, sinceLow 0, close < prior low`);
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
