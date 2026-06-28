import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    buildMomentum,
    buildRangePercentile,
    getPreparedRelativeStrengthRangeData,
    hasDirectionalAcceptance,
    hasEnoughBars,
    normalizeIntegerParam,
    normalizeNumberParam,
    prepareRelativeStrengthRangeData,
} from "./relative-strength-range-core";

const MAX_ABS_RETURN = 0.075;

function normalizeRangeExpansionFollowThroughParams(params: StrategyParams): StrategyParams {
    return {
        range_lookback: normalizeIntegerParam(params.range_lookback, 36, 12, 120),
        momentum_lookback: normalizeIntegerParam(params.momentum_lookback, 3, 1, 20),
        range_percentile_min: normalizeNumberParam(params.range_percentile_min, 0.72, 0.2, 0.98),
        acceptance_min: normalizeNumberParam(params.acceptance_min, 0.4, 0.05, 0.95),
    };
}

function executeRangeExpansionFollowThrough(preparedData: unknown, params: StrategyParams, data: OHLCVData[]) {
    const prepared = getPreparedRelativeStrengthRangeData(preparedData, data);
    const p = normalizeRangeExpansionFollowThroughParams(params);
    const rangeLookback = p.range_lookback as number;
    const momentumLookback = p.momentum_lookback as number;
    if (!hasEnoughBars(prepared.cleanData, rangeLookback + momentumLookback + 2)) return [];

    const rangePercentile = buildRangePercentile(prepared, rangeLookback);
    const momentum = buildMomentum(prepared.closes, momentumLookback);

    return createSignalLoop(prepared.cleanData, [rangePercentile, momentum], (i) => {
        if (i < rangeLookback + momentumLookback) return null;
        const pct = rangePercentile[i];
        const mom = momentum[i];
        if (pct === null || mom === null || pct < (p.range_percentile_min as number)) return null;
        if (Math.abs(prepared.closeReturn[i]) > MAX_ABS_RETURN) return null;

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
        range_percentile_min: 0.72,
        acceptance_min: 0.4,
    },
    paramLabels: {
        range_lookback: "Range Lookback",
        momentum_lookback: "Momentum Lookback",
        range_percentile_min: "Min Range Percentile",
        acceptance_min: "Min Acceptance",
    },
    normalizeParams: normalizeRangeExpansionFollowThroughParams,
    prepareFinderData: (data) => prepareRelativeStrengthRangeData(data),
    executePrepared: executeRangeExpansionFollowThrough,
    execute: (data, params) => executeRangeExpansionFollowThrough(prepareRelativeStrengthRangeData(data), params, data),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["range_lookback", "momentum_lookback", "range_percentile_min", "acceptance_min"],
    },
};
