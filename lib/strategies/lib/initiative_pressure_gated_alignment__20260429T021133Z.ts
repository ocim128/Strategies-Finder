import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeInitiativePressureGatedAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        pressure_threshold: Math.max(0, Number(params.pressure_threshold ?? 0.6)),
    };
}

export const initiative_pressure_gated_alignment: Strategy = {
    name: "Initiative Pressure Gated Alignment",
    description:
        "Uses initiative pressure only as a directional gate while the actual entry anchor remains a simple trailing rolling median of daily closes.",
    defaultParams: {
        lookback: 63,
        pressure_threshold: 0.6,
    },
    paramLabels: {
        lookback: "Lookback",
        pressure_threshold: "Pressure Threshold",
    },
    normalizeParams: normalizeInitiativePressureGatedAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureGatedAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [pressure, median], (i) => {
            if (i < lookback - 1) return null;

            const pressureValue = pressure[i];
            const med = median[i];
            if (pressureValue === null || med === null) return null;

            if (pressureValue > (p.pressure_threshold as number) && closes[i] > med) {
                return createBuySignal(cleanData, i, `Positive initiative pressure ${pressureValue.toFixed(3)} with close above median`);
            }
            if (pressureValue < -(p.pressure_threshold as number) && closes[i] < med) {
                return createSellSignal(cleanData, i, `Negative initiative pressure ${pressureValue.toFixed(3)} with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pressure_threshold"],
    },
};
