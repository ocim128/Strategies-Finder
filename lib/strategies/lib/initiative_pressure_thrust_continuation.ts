import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

const THRUST_Z_SCORE = 1.5;

function normalizeInitiativePressureThrustContinuationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const initiative_pressure_thrust_continuation: Strategy = {
    name: "Initiative Pressure Thrust Continuation",
    description: "Continues the direction of volume-relative close-acceptance thrust when its rolling z-score is extreme and the bar closes in agreement.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeInitiativePressureThrustContinuationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeInitiativePressureThrustContinuationParams(params).lookback as number;
        if (cleanData.length < 2 * lookback - 1) return [];

        const pressure = buildInitiativePressureSeries(cleanData, lookback).map((value) => value ?? 0);
        const z = buildRollingZScore(pressure, lookback);

        return createSignalLoop(cleanData, [z], (i) => {
            // The initiative-pressure series itself only fills after `lookback`
            // bars; the z-score window must not contain those null-filled zeros.
            if (i < 2 * lookback - 2) return null;
            const zScore = z[i];
            if (zScore === null) return null;
            const bar = cleanData[i];

            if (zScore > THRUST_Z_SCORE && bar.close > bar.open) {
                return createBuySignal(cleanData, i, `Initiative pressure thrust buy: z ${zScore.toFixed(2)} with bullish close`);
            }
            if (zScore < -THRUST_Z_SCORE && bar.close < bar.open) {
                return createSellSignal(cleanData, i, `Initiative pressure thrust sell: z ${zScore.toFixed(2)} with bearish close`);
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
