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

function normalizeInitiativePressureMedianAnchorParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        pressure_min: Math.max(0, Number(params.pressure_min ?? 0.2)),
    };
}

export const initiative_pressure_median_anchor: Strategy = {
    name: "Initiative Pressure Median Anchor",
    description:
        "Requires signed initiative pressure to agree with the completed close's side of a rolling median.",
    defaultParams: {
        lookback: 20,
        pressure_min: 0.2,
    },
    paramLabels: {
        lookback: "Lookback",
        pressure_min: "Pressure Minimum",
    },
    normalizeParams: normalizeInitiativePressureMedianAnchorParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureMedianAnchorParams(params);
        const lookback = p.lookback as number;
        const pressureMin = p.pressure_min as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [pressure, median], (i) => {
            const pressureValue = pressure[i];
            const med = median[i];
            if (pressureValue === null || med === null) return null;

            if (pressureValue > pressureMin && closes[i] > med) {
                return createBuySignal(cleanData, i, `Initiative pressure ${pressureValue.toFixed(2)} above median`);
            }
            if (pressureValue < -pressureMin && closes[i] < med) {
                return createSellSignal(cleanData, i, `Initiative pressure ${pressureValue.toFixed(2)} below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pressure_min"],
    },
};
