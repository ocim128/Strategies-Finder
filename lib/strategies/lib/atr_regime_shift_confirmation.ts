import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    buildEfficiency,
    buildMomentum,
    getAtrSeries,
    getPreparedRelativeStrengthRangeData,
    hasDirectionalAcceptance,
    hasEnoughBars,
    isOverextendedMove,
    normalizeIntegerParam,
    normalizeNumberParam,
    prepareRelativeStrengthRangeData,
} from "./relative-strength-range-core";

function normalizeAtrRegimeShiftConfirmationParams(params: StrategyParams): StrategyParams {
    return {
        fast_atr_period: normalizeIntegerParam(params.fast_atr_period, 8, 3, 60),
        slow_atr_period: normalizeIntegerParam(params.slow_atr_period, 34, 8, 160),
        momentum_lookback: normalizeIntegerParam(params.momentum_lookback, 6, 2, 60),
        atr_ratio_min: normalizeNumberParam(params.atr_ratio_min, 1.08, 0.5, 4),
        efficiency_min: normalizeNumberParam(params.efficiency_min, 0.22, 0.05, 0.95),
        acceptance_min: normalizeNumberParam(params.acceptance_min, 0.32, 0.05, 0.95),
        max_range_atr: normalizeNumberParam(params.max_range_atr, 2.9, 0.5, 10),
    };
}

function executeAtrRegimeShiftConfirmation(preparedData: unknown, params: StrategyParams, data: OHLCVData[]) {
    const prepared = getPreparedRelativeStrengthRangeData(preparedData, data);
    const p = normalizeAtrRegimeShiftConfirmationParams(params);
    const fastAtrPeriod = p.fast_atr_period as number;
    const slowAtrPeriod = p.slow_atr_period as number;
    const momentumLookback = p.momentum_lookback as number;
    if (!hasEnoughBars(prepared.cleanData, slowAtrPeriod + momentumLookback + 2)) return [];

    const fastAtr = getAtrSeries(prepared, fastAtrPeriod);
    const slowAtr = getAtrSeries(prepared, slowAtrPeriod);
    const momentum = buildMomentum(prepared.closes, momentumLookback);
    const efficiency = buildEfficiency(prepared, momentumLookback);

    return createSignalLoop(prepared.cleanData, [fastAtr, slowAtr, momentum, efficiency], (i) => {
        if (i < slowAtrPeriod + momentumLookback) return null;
        const fast = fastAtr[i];
        const slow = slowAtr[i];
        const mom = momentum[i];
        const eff = efficiency[i];
        if (fast === null || slow === null || slow <= 0 || mom === null || eff === null) return null;
        if (fast / slow < (p.atr_ratio_min as number) || eff < (p.efficiency_min as number)) return null;
        if (isOverextendedMove(prepared, i, fastAtr, p.max_range_atr as number, 0.085)) return null;

        if (mom > 0 && hasDirectionalAcceptance(prepared, i, p.acceptance_min as number, 1)) {
            return createBuySignal(prepared.cleanData, i, `ATR regime shift confirms upside ${(fast / slow).toFixed(2)}`);
        }
        if (mom < 0 && hasDirectionalAcceptance(prepared, i, p.acceptance_min as number, -1)) {
            return createSellSignal(prepared.cleanData, i, `ATR regime shift confirms downside ${(fast / slow).toFixed(2)}`);
        }
        return null;
    });
}

// Captures relative moves when volatility shifts from quiet to active and direction is efficient.
export const atr_regime_shift_confirmation: Strategy = {
    name: "ATR Regime Shift Confirmation",
    description: "Trades relative direction only after fast ATR rises above slow ATR and the move is efficient enough to avoid random volatility bursts.",
    defaultParams: {
        fast_atr_period: 8,
        slow_atr_period: 34,
        momentum_lookback: 6,
        atr_ratio_min: 1.08,
        efficiency_min: 0.22,
        acceptance_min: 0.32,
        max_range_atr: 2.9,
    },
    paramLabels: {
        fast_atr_period: "Fast ATR Period",
        slow_atr_period: "Slow ATR Period",
        momentum_lookback: "Momentum Lookback",
        atr_ratio_min: "Min Fast / Slow ATR",
        efficiency_min: "Min Efficiency",
        acceptance_min: "Min Acceptance",
        max_range_atr: "Max Range / Fast ATR",
    },
    normalizeParams: normalizeAtrRegimeShiftConfirmationParams,
    prepareFinderData: (data) => prepareRelativeStrengthRangeData(data),
    executePrepared: executeAtrRegimeShiftConfirmation,
    execute: (data, params) => executeAtrRegimeShiftConfirmation(prepareRelativeStrengthRangeData(data), params, data),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fast_atr_period", "slow_atr_period", "momentum_lookback", "atr_ratio_min", "efficiency_min", "acceptance_min", "max_range_atr"],
    },
};
