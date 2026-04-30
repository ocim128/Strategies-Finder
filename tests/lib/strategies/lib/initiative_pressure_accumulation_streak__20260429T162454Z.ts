import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

const INITIATIVE_PRESSURE_STREAK_LOOKBACK = 10;

function normalizeInitiativePressureAccumulationStreakParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streak_threshold: Math.max(1, Math.round(Number(params.streak_threshold ?? 3))),
        median_lookback: Math.max(2, Math.round(Number(params.median_lookback ?? 63))),
    };
}

export const initiative_pressure_accumulation_streak: Strategy = {
    name: "Initiative Pressure Accumulation Streak",
    description:
        "Looks for consecutive days of same-sided initiative pressure and only aligns with that participation streak when price is already on the same side of a longer median anchor.",
    defaultParams: {
        streak_threshold: 3,
        median_lookback: 63,
    },
    paramLabels: {
        streak_threshold: "Streak Threshold",
        median_lookback: "Median Lookback",
    },
    normalizeParams: normalizeInitiativePressureAccumulationStreakParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureAccumulationStreakParams(params);
        const minBars = Math.max(INITIATIVE_PRESSURE_STREAK_LOOKBACK, p.median_lookback as number);
        if (cleanData.length < minBars) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, p.median_lookback as number);
        const initiativePressure = buildInitiativePressureSeries(cleanData, INITIATIVE_PRESSURE_STREAK_LOOKBACK);
        const streaks = buildStreakCount(
            initiativePressure.map((value) => value === null ? 0 : value > 0 ? 1 : value < 0 ? -1 : 0)
        );

        return createSignalLoop(cleanData, [median, initiativePressure], (i) => {
            const med = median[i];
            if (med === null) return null;

            if (streaks[i] >= (p.streak_threshold as number) && closes[i] > med) {
                return createBuySignal(cleanData, i, `Positive initiative streak ${streaks[i]} with close above median`);
            }
            if (streaks[i] <= -(p.streak_threshold as number) && closes[i] < med) {
                return createSellSignal(cleanData, i, `Negative initiative streak ${Math.abs(streaks[i])} with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streak_threshold", "median_lookback"],
    },
};
