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

const RANGE_LOOKBACK = 98;
const ATR_PERIOD = 28;
const ACCEPTANCE_MIN = 0;

function normalizeDirectionalBodyAcceptanceParams(params: StrategyParams): StrategyParams {
    return {
        momentum_lookback: normalizeIntegerParam(params.momentum_lookback, 4, 1, 30),
        body_min: normalizeNumberParam(params.body_min, 0.52, 0.1, 0.95),
        range_percentile_min: normalizeNumberParam(params.range_percentile_min, 0.45, 0.05, 0.95),
        max_range_atr: normalizeNumberParam(params.max_range_atr, 2.4, 0.5, 10),
    };
}

function executeDirectionalBodyAcceptance(preparedData: unknown, params: StrategyParams, data: OHLCVData[]) {
    const prepared = getPreparedRelativeStrengthRangeData(preparedData, data);
    const p = normalizeDirectionalBodyAcceptanceParams(params);
    const momentumLookback = p.momentum_lookback as number;
    const rangeLookback = RANGE_LOOKBACK;
    const atrPeriod = ATR_PERIOD;
    if (!hasEnoughBars(prepared.cleanData, Math.max(rangeLookback, atrPeriod) + momentumLookback + 2)) return [];

    const momentum = buildMomentum(prepared.closes, momentumLookback);
    const rangePercentile = buildRangePercentile(prepared, rangeLookback);
    const atr = getAtrSeries(prepared, atrPeriod);

    return createSignalLoop(prepared.cleanData, [momentum, rangePercentile, atr], (i) => {
        if (i < Math.max(rangeLookback, atrPeriod) + momentumLookback) return null;
        const mom = momentum[i];
        const pct = rangePercentile[i];
        if (mom === null || pct === null || pct < (p.range_percentile_min as number)) return null;
        if (prepared.bodyPct[i] < (p.body_min as number)) return null;
        if (isOverextendedMove(prepared, i, atr, p.max_range_atr as number, 0.065)) return null;

        if (mom > 0 && hasDirectionalAcceptance(prepared, i, ACCEPTANCE_MIN, 1)) {
            return createBuySignal(prepared.cleanData, i, `Directional body accepts upside ${(prepared.bodyPct[i]).toFixed(2)}`);
        }
        if (mom < 0 && hasDirectionalAcceptance(prepared, i, ACCEPTANCE_MIN, -1)) {
            return createSellSignal(prepared.cleanData, i, `Directional body accepts downside ${(prepared.bodyPct[i]).toFixed(2)}`);
        }
        return null;
    });
}

// Captures decisive candle bodies that close where relative buyers or sellers kept control.
export const directional_body_acceptance: Strategy = {
    name: "Directional Body Acceptance",
    description: "Trades decisive body candles only when the body, close acceptance, range rank, and short relative momentum all point the same way.",
    defaultParams: {
        momentum_lookback: 4,
        body_min: 0.52,
        range_percentile_min: 0.45,
        max_range_atr: 2.4,
    },
    paramLabels: {
        momentum_lookback: "Momentum Lookback",
        body_min: "Min Body Share",
        range_percentile_min: "Min Range Percentile",
        max_range_atr: "Max Range / ATR",
    },
    normalizeParams: normalizeDirectionalBodyAcceptanceParams,
    prepareFinderData: (data) => prepareRelativeStrengthRangeData(data),
    executePrepared: executeDirectionalBodyAcceptance,
    execute: (data, params) => executeDirectionalBodyAcceptance(prepareRelativeStrengthRangeData(data), params, data),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["momentum_lookback", "body_min", "range_percentile_min", "max_range_atr"],
    },
};
