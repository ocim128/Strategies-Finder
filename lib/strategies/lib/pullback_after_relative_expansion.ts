import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    buildMomentum,
    buildRangePercentile,
    getAtrSeries,
    getPreparedRelativeStrengthRangeData,
    getSmaSeries,
    hasEnoughBars,
    isOverextendedMove,
    normalizeIntegerParam,
    normalizeNumberParam,
    prepareRelativeStrengthRangeData,
} from "./relative-strength-range-core";

function normalizePullbackAfterRelativeExpansionParams(params: StrategyParams): StrategyParams {
    return {
        expansion_lookback: normalizeIntegerParam(params.expansion_lookback, 40, 12, 160),
        trend_lookback: normalizeIntegerParam(params.trend_lookback, 20, 6, 120),
        pullback_lookback: normalizeIntegerParam(params.pullback_lookback, 3, 1, 12),
        atr_period: normalizeIntegerParam(params.atr_period, 14, 4, 80),
        expansion_percentile_min: normalizeNumberParam(params.expansion_percentile_min, 0.72, 0.2, 0.98),
        pullback_max: normalizeNumberParam(params.pullback_max, 0.025, 0.001, 0.25),
        acceptance_reclaim_min: normalizeNumberParam(params.acceptance_reclaim_min, 0.08, 0, 0.8),
        max_range_atr: normalizeNumberParam(params.max_range_atr, 2.3, 0.5, 10),
    };
}

function executePullbackAfterRelativeExpansion(preparedData: unknown, params: StrategyParams, data: OHLCVData[]) {
    const prepared = getPreparedRelativeStrengthRangeData(preparedData, data);
    const p = normalizePullbackAfterRelativeExpansionParams(params);
    const expansionLookback = p.expansion_lookback as number;
    const trendLookback = p.trend_lookback as number;
    const pullbackLookback = p.pullback_lookback as number;
    const atrPeriod = p.atr_period as number;
    if (!hasEnoughBars(prepared.cleanData, Math.max(expansionLookback, trendLookback, atrPeriod) + pullbackLookback + 2)) return [];

    const rangePercentile = buildRangePercentile(prepared, expansionLookback);
    const trendMomentum = buildMomentum(prepared.closes, trendLookback);
    const pullbackMomentum = buildMomentum(prepared.closes, pullbackLookback);
    const trendSma = getSmaSeries(prepared, trendLookback);
    const atr = getAtrSeries(prepared, atrPeriod);

    return createSignalLoop(prepared.cleanData, [rangePercentile, trendMomentum, pullbackMomentum, trendSma, atr], (i) => {
        if (i < Math.max(expansionLookback, trendLookback, atrPeriod) + pullbackLookback) return null;
        const trend = trendMomentum[i];
        const pullback = pullbackMomentum[i];
        const sma = trendSma[i];
        if (trend === null || pullback === null || sma === null) return null;
        if (rangePercentile[i - pullbackLookback] === null || rangePercentile[i - pullbackLookback]! < (p.expansion_percentile_min as number)) return null;
        if (Math.abs(pullback) > (p.pullback_max as number)) return null;
        if (isOverextendedMove(prepared, i, atr, p.max_range_atr as number, 0.06)) return null;

        if (trend > 0 && pullback <= 0 && prepared.closes[i] >= sma && prepared.closeAcceptance[i] >= (p.acceptance_reclaim_min as number)) {
            return createBuySignal(prepared.cleanData, i, "Pullback after relative expansion reclaimed upside");
        }
        if (trend < 0 && pullback >= 0 && prepared.closes[i] <= sma && prepared.closeAcceptance[i] <= -(p.acceptance_reclaim_min as number)) {
            return createSellSignal(prepared.cleanData, i, "Pullback after relative expansion reclaimed downside");
        }
        return null;
    });
}

// Captures second-chance entries after a relative expansion cools off without fully reversing.
export const pullback_after_relative_expansion: Strategy = {
    name: "Pullback After Relative Expansion",
    description: "Waits for a high-range relative expansion, then enters only after a small pullback reclaims the trend side.",
    defaultParams: {
        expansion_lookback: 40,
        trend_lookback: 20,
        pullback_lookback: 3,
        atr_period: 14,
        expansion_percentile_min: 0.72,
        pullback_max: 0.025,
        acceptance_reclaim_min: 0.08,
        max_range_atr: 2.3,
    },
    paramLabels: {
        expansion_lookback: "Expansion Lookback",
        trend_lookback: "Trend Lookback",
        pullback_lookback: "Pullback Lookback",
        atr_period: "ATR Period",
        expansion_percentile_min: "Min Expansion Percentile",
        pullback_max: "Max Pullback Move",
        acceptance_reclaim_min: "Min Reclaim Acceptance",
        max_range_atr: "Max Range / ATR",
    },
    normalizeParams: normalizePullbackAfterRelativeExpansionParams,
    prepareFinderData: (data) => prepareRelativeStrengthRangeData(data),
    executePrepared: executePullbackAfterRelativeExpansion,
    execute: (data, params) => executePullbackAfterRelativeExpansion(prepareRelativeStrengthRangeData(data), params, data),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["expansion_lookback", "trend_lookback", "pullback_lookback", "atr_period", "expansion_percentile_min", "pullback_max", "acceptance_reclaim_min", "max_range_atr"],
    },
};
