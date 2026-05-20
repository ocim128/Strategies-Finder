import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeInitiativePressurePersistenceStreakPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        pressureLookback: normalizeIntegerParam(params.pressureLookback, 20, 2),
        streakThreshold: normalizeIntegerParam(params.streakThreshold, 3, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.01, 0),
    };
}

export const initiative_pressure_persistence_streak_pressure_gap: Strategy = {
    name: "Initiative Pressure Persistence Streak Pressure Gap",
    description: "Requires a sustained Binance initiative-pressure streak and same-side Polymarket pressure gap edge.",
    defaultParams: {
        pressureLookback: 20,
        streakThreshold: 3,
        minEdge: 0.01,
    },
    paramLabels: {
        pressureLookback: "Pressure Lookback",
        streakThreshold: "Streak Threshold",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeInitiativePressurePersistenceStreakPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressurePersistenceStreakPressureGapParams(params);
        const lookback = p.pressureLookback;
        if (cleanData.length < lookback + p.streakThreshold) return [];

        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const flags = initiative.map((value) => value === null ? 0 : value > 0 ? 1 : value < 0 ? -1 : 0);
        const streak = buildStreakCount(flags);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [initiative, pressure.longEdge, pressure.shortEdge], (i) => {
            if (i < lookback) return null;
            if (streak[i] >= p.streakThreshold && (pressure.longEdge[i] ?? -Infinity) >= p.minEdge) {
                return createBuySignal(cleanData, i, "Initiative pressure buy streak with long pressure edge");
            }
            if (streak[i] <= -p.streakThreshold && (pressure.shortEdge[i] ?? -Infinity) >= p.minEdge) {
                return createSellSignal(cleanData, i, "Initiative pressure sell streak with short pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["pressureLookback", "streakThreshold", "minEdge"],
    },
};
