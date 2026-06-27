import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    buildMomentum,
    buildReturnZScore,
    getAtrSeries,
    getPreparedRelativeStrengthRangeData,
    hasDirectionalAcceptance,
    hasEnoughBars,
    isOverextendedMove,
    normalizeIntegerParam,
    normalizeNumberParam,
    prepareRelativeStrengthRangeData,
} from "./relative-strength-range-core";

function normalizeBaseQuoteMomentumDivergenceParams(params: StrategyParams): StrategyParams {
    return {
        fast_lookback: normalizeIntegerParam(params.fast_lookback, 3, 1, 30),
        slow_lookback: normalizeIntegerParam(params.slow_lookback, 20, 6, 120),
        z_lookback: normalizeIntegerParam(params.z_lookback, 48, 12, 160),
        atr_period: normalizeIntegerParam(params.atr_period, 14, 4, 80),
        divergence_min: normalizeNumberParam(params.divergence_min, 0.01, 0.001, 0.2),
        z_abs_max: normalizeNumberParam(params.z_abs_max, 1.8, 0.4, 5),
        acceptance_min: normalizeNumberParam(params.acceptance_min, 0.2, 0.0, 0.95),
        max_range_atr: normalizeNumberParam(params.max_range_atr, 2.6, 0.5, 10),
    };
}

function executeBaseQuoteMomentumDivergence(preparedData: unknown, params: StrategyParams, data: OHLCVData[]) {
    const prepared = getPreparedRelativeStrengthRangeData(preparedData, data);
    const p = normalizeBaseQuoteMomentumDivergenceParams(params);
    const fastLookback = p.fast_lookback as number;
    const slowLookback = p.slow_lookback as number;
    const zLookback = p.z_lookback as number;
    const atrPeriod = p.atr_period as number;
    if (!hasEnoughBars(prepared.cleanData, Math.max(slowLookback, zLookback, atrPeriod) + 2)) return [];

    const fastMomentum = buildMomentum(prepared.closes, fastLookback);
    const slowMomentum = buildMomentum(prepared.closes, slowLookback);
    const returnZ = buildReturnZScore(prepared, zLookback);
    const atr = getAtrSeries(prepared, atrPeriod);

    return createSignalLoop(prepared.cleanData, [fastMomentum, slowMomentum, returnZ, atr], (i) => {
        if (i < Math.max(slowLookback, zLookback, atrPeriod)) return null;
        const fast = fastMomentum[i];
        const slow = slowMomentum[i];
        const z = returnZ[i];
        if (fast === null || slow === null || z === null) return null;
        if (Math.abs(z) > (p.z_abs_max as number)) return null;
        if (isOverextendedMove(prepared, i, atr, p.max_range_atr as number, 0.075)) return null;

        const divergence = fast - slow;
        if (divergence > (p.divergence_min as number) && hasDirectionalAcceptance(prepared, i, p.acceptance_min as number, 1)) {
            return createBuySignal(prepared.cleanData, i, `Base/quote momentum divergence ${divergence.toFixed(3)}`);
        }
        if (divergence < -(p.divergence_min as number) && hasDirectionalAcceptance(prepared, i, p.acceptance_min as number, -1)) {
            return createSellSignal(prepared.cleanData, i, `Base/quote momentum divergence ${divergence.toFixed(3)}`);
        }
        return null;
    });
}

// Captures early relative leadership when fast ratio momentum separates from the slower base/quote trend.
export const base_quote_momentum_divergence: Strategy = {
    name: "Base Quote Momentum Divergence",
    description: "Uses synthetic-ratio fast-minus-slow momentum as a base-versus-quote leadership divergence, with z-score and range caps to avoid late extremes.",
    defaultParams: {
        fast_lookback: 3,
        slow_lookback: 20,
        z_lookback: 48,
        atr_period: 14,
        divergence_min: 0.01,
        z_abs_max: 1.8,
        acceptance_min: 0.2,
        max_range_atr: 2.6,
    },
    paramLabels: {
        fast_lookback: "Fast Lookback",
        slow_lookback: "Slow Lookback",
        z_lookback: "Return Z Lookback",
        atr_period: "ATR Period",
        divergence_min: "Min Momentum Divergence",
        z_abs_max: "Max Return Z",
        acceptance_min: "Min Acceptance",
        max_range_atr: "Max Range / ATR",
    },
    normalizeParams: normalizeBaseQuoteMomentumDivergenceParams,
    prepareFinderData: (data) => prepareRelativeStrengthRangeData(data),
    executePrepared: executeBaseQuoteMomentumDivergence,
    execute: (data, params) => executeBaseQuoteMomentumDivergence(prepareRelativeStrengthRangeData(data), params, data),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fast_lookback", "slow_lookback", "z_lookback", "atr_period", "divergence_min", "z_abs_max", "acceptance_min", "max_range_atr"],
    },
};
