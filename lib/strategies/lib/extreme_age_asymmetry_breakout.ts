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
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
    };
}

export const extreme_age_asymmetry_breakout: Strategy = {
    name: "Extreme Age Asymmetry Breakout",
    description: "Enters trend continuation when extreme age asymmetry reaches severe divergence between opposing boundaries.",
    defaultParams: {
        lookback: 30,
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
        const staleThreshold = Math.round(lookback * 0.75);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            const sh = sinceHigh[i];
            const sl = sinceLow[i];
            if (sh === null || sl === null) return null;

            // Buy: Ceiling is fresh (<= 2), floor is stale (>= 75% lookback), bull bar
            if (sh <= 2 && sl >= staleThreshold && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish age asymmetry breakout: sinceHigh ${sh} <= 2, sinceLow ${sl} >= ${staleThreshold}, bull close`);
            }

            // Sell: Floor is fresh (<= 2), ceiling is stale (>= 75% lookback), bear bar
            if (sl <= 2 && sh >= staleThreshold && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish age asymmetry breakout: sinceLow ${sl} <= 2, sinceHigh ${sh} >= ${staleThreshold}, bear close`);
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
