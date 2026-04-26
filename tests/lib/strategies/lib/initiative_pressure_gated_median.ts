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

function normalizeInitiativePressureGatedMedianParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        median_lookback: Math.max(2, Math.round(params.median_lookback ?? 20)),
        pressure_lookback: Math.max(2, Math.round(params.pressure_lookback ?? 10)),
    };
}

export const initiative_pressure_gated_median: Strategy = {
    name: "Initiative Pressure Gated Median",
    description: "Initiative pressure measures whether aggressive participants are buying or selling based on bar geometry. When pressure is positive, buyers are dominant; when negative, sellers are dominant. Align the close with the rolling median only in the direction indicated by initiative pressure.",
    defaultParams: {
        median_lookback: 20,
        pressure_lookback: 10,
    },
    paramLabels: {
        median_lookback: "Median Lookback",
        pressure_lookback: "Pressure Lookback",
    },
    normalizeParams: normalizeInitiativePressureGatedMedianParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureGatedMedianParams(params);
        const minLookback = Math.max(p.median_lookback, p.pressure_lookback);
        if (cleanData.length < minLookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, p.median_lookback);
        const pressure = buildInitiativePressureSeries(cleanData, p.pressure_lookback);

        return createSignalLoop(cleanData, [median, pressure], (i) => {
            if (i < minLookback) return null;
            const med = median[i];
            const pres = pressure[i];
            if (med === null || pres === null) return null;

            if (pres > 0 && closes[i] > med) {
                return createBuySignal(cleanData, i, `Positive initiative pressure (${pres.toFixed(3)}) with close above median`);
            }
            if (pres < 0 && closes[i] < med) {
                return createSellSignal(cleanData, i, `Negative initiative pressure (${pres.toFixed(3)}) with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["median_lookback", "pressure_lookback"],
    },
};
