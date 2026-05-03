import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    checkCrossover,
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR, calculateDonchianChannels } from "../indicators";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

const VOLATILITY_REGIME_ATR_RANK_LOOKBACK = 200;

function normalizeVolatilityRegimeExpansionRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 55))),
        atr_threshold: Math.max(0.01, Math.min(0.99, Number(params.atr_threshold ?? 0.3))),
    };
}

export const volatility_regime_expansion_router: Strategy = {
    name: "Volatility Regime Expansion Router",
    description:
        "Routes low ATR-percentile compression to Donchian breakouts and higher-volatility regimes to median reversion crosses.",
    defaultParams: {
        lookback: 55,
        atr_threshold: 0.3,
    },
    paramLabels: {
        lookback: "Lookback",
        atr_threshold: "ATR Threshold",
    },
    normalizeParams: normalizeVolatilityRegimeExpansionRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilityRegimeExpansionRouterParams(params);
        const lookback = p.lookback as number;
        const atrThreshold = p.atr_threshold as number;
        const rankLookback = Math.max(VOLATILITY_REGIME_ATR_RANK_LOOKBACK, lookback * 2);
        if (cleanData.length < rankLookback + 2) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const atr = calculateATR(highs, lows, closes, lookback);
        const atrRank = buildPercentileRank(atr.map((value) => value ?? 0), rankLookback);
        const donchian = calculateDonchianChannels(highs, lows, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [atr, atrRank, donchian.upper, donchian.lower, median], (i) => {
            if (i < rankLookback + 1) return null;

            const rank = atrRank[i];
            const priorUpper = donchian.upper[i - 1];
            const priorLower = donchian.lower[i - 1];
            if (rank === null || priorUpper === null || priorLower === null) return null;

            if (rank < atrThreshold) {
                if (closes[i - 1] <= priorUpper && closes[i] > priorUpper) {
                    return createBuySignal(cleanData, i, `Compression Donchian breakout ATR rank ${(rank * 100).toFixed(0)}%`);
                }
                if (closes[i - 1] >= priorLower && closes[i] < priorLower) {
                    return createSellSignal(cleanData, i, `Compression Donchian breakdown ATR rank ${(rank * 100).toFixed(0)}%`);
                }
                return null;
            }

            const cross = checkCrossover(closes, median, i);
            if (cross === "bullish") {
                return createBuySignal(cleanData, i, `Expansion median reversion cross ATR rank ${(rank * 100).toFixed(0)}%`);
            }
            if (cross === "bearish") {
                return createSellSignal(cleanData, i, `Expansion median reversion cross ATR rank ${(rank * 100).toFixed(0)}%`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "atr_threshold"],
    },
};
