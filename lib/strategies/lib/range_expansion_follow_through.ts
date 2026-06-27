import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    buildMomentum,
    buildRangePercentile,
    getAtrSeries,
    getPreparedRelativeStrengthRangeData,
    hasDirectionalAcceptance,
    hasEnoughBars,
    isOverextendedMove,
    normalizeIntegerParam,
    normalizeNumberParam,
    prepareRelativeStrengthRangeData,
} from "./relative-strength-range-core";

function normalizeRangeExpansionFollowThroughParams(params: StrategyParams): StrategyParams {
    return {
        range_lookback: normalizeIntegerParam(params.range_lookback, 36, 12, 120),
        momentum_lookback: normalizeIntegerParam(params.momentum_lookback, 3, 1, 20),
        atr_period: normalizeIntegerParam(params.atr_period, 14, 4, 80),
        range_percentile_min: normalizeNumberParam(params.range_percentile_min, 0.72, 0.2, 0.98),
        acceptance_min: normalizeNumberParam(params.acceptance_min, 0.4, 0.05, 0.95),
        max_range_atr: normalizeNumberParam(params.max_range_atr, 2.6, 0.5, 10),
    };
}

function executeRangeExpansionFollowThrough(preparedData: unknown, params: StrategyParams, data: OHLCVData[]) {
    const prepared = getPreparedRelativeStrengthRangeData(preparedData, data);
    const p = normalizeRangeExpansionFollowThroughParams(params);
    const rangeLookback = p.range_lookback as number;
    const momentumLookback = p.momentum_lookback as number;
    const atrPeriod = p.atr_period as number;
    if (!hasEnoughBars(prepared.cleanData, Math.max(rangeLookback, atrPeriod) + momentumLookback + 2)) return [];

    const rangePercentile = buildRangePercentile(prepared, rangeLookback);
    const momentum = buildMomentum(prepared.closes, momentumLookback);
    const atr = getAtrSeries(prepared, atrPeriod);

    return createSignalLoop(prepared.cleanData, [rangePercentile, momentum, atr], (i) => {
        if (i < Math.max(rangeLookback, atrPeriod) + momentumLookback) return null;
        const pct = rangePercentile[i];
        const mom = momentum[i];
        if (pct === null || mom === null || pct < (p.range_percentile_min as number)) return null;
        if (isOverextendedMove(prepared, i, atr, p.max_range_atr as number, 0.075)) return null;

        if (mom > 0 && hasDirectionalAcceptance(prepared, i, p.acceptance_min as number, 1)) {
            return createBuySignal(prepared.cleanData, i, `Range expansion follow-through ${pct.toFixed(2)}`);
        }
        if (mom < 0 && hasDirectionalAcceptance(prepared, i, p.acceptance_min as number, -1)) {
            return createSellSignal(prepared.cleanData, i, `Range expansion follow-through ${pct.toFixed(2)}`);
        }
        return null;
    });
}

// Captures continuation when a large relative range expands in the same direction as short momentum.
export const range_expansion_follow_through: Strategy = {
    name: "Range Expansion Follow Through",
    description: "Follows high-percentile range expansion only when short relative momentum and close acceptance agree.",
    defaultParams: {
        range_lookback: 36,
        momentum_lookback: 3,
        atr_period: 14,
        range_percentile_min: 0.72,
        acceptance_min: 0.4,
        max_range_atr: 2.6,
    },
    paramLabels: {
        range_lookback: "Range Lookback",
        momentum_lookback: "Momentum Lookback",
        atr_period: "ATR Period",
        range_percentile_min: "Min Range Percentile",
        acceptance_min: "Min Acceptance",
        max_range_atr: "Max Range / ATR",
    },
    normalizeParams: normalizeRangeExpansionFollowThroughParams,
    prepareFinderData: (data) => prepareRelativeStrengthRangeData(data),
    executePrepared: executeRangeExpansionFollowThrough,
    execute: (data, params) => executeRangeExpansionFollowThrough(prepareRelativeStrengthRangeData(data), params, data),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["range_lookback", "momentum_lookback", "atr_period", "range_percentile_min", "acceptance_min", "max_range_atr"],
    },
};
