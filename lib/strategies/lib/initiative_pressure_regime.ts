import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildInitiativePressureSeries, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeInitiativePressureRegimeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        pressure_lookback: Math.max(2, Math.round(Number(params.pressure_lookback ?? 20))),
        high_threshold: Math.max(0, Number(params.high_threshold ?? 0.6)),
    };
}

export const initiative_pressure_regime: Strategy = {
    name: "Initiative Pressure Regime",
    description:
        "Routes high signed initiative pressure to median-following trades and low-pressure bars to trailing-range reversion.",
    defaultParams: {
        pressure_lookback: 20,
        high_threshold: 0.6,
    },
    paramLabels: {
        pressure_lookback: "Pressure Lookback",
        high_threshold: "High Threshold",
    },
    normalizeParams: normalizeInitiativePressureRegimeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureRegimeParams(params);
        const lookback = p.pressure_lookback as number;
        const threshold = p.high_threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const median = buildRollingMedian(closes, lookback);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);

        return createSignalLoop(cleanData, [pressure, median, highest, lowest], (i) => {
            const pressureValue = pressure[i];
            const med = median[i];
            const hi = highest[i];
            const lo = lowest[i];
            if (pressureValue === null || med === null || hi === null || lo === null) return null;

            if (Math.abs(pressureValue) >= threshold) {
                if (pressureValue > 0 && closes[i] > med) {
                    return createBuySignal(cleanData, i, `High positive initiative pressure ${pressureValue.toFixed(2)}`);
                }
                if (pressureValue < 0 && closes[i] < med) {
                    return createSellSignal(cleanData, i, `High negative initiative pressure ${pressureValue.toFixed(2)}`);
                }
                return null;
            }

            const range = hi - lo;
            if (range <= 0) return null;
            const position = (closes[i] - lo) / range;
            if (position <= 0.25) {
                return createBuySignal(cleanData, i, `Low-pressure lower range fade ${(position * 100).toFixed(0)}%`);
            }
            if (position >= 0.75) {
                return createSellSignal(cleanData, i, `Low-pressure upper range fade ${(position * 100).toFixed(0)}%`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["pressure_lookback", "high_threshold"],
    },
};
