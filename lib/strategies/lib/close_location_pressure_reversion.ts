import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
        pressureThreshold: Math.max(0.5, Math.min(1.0, Number(params.pressureThreshold ?? 0.70))),
    };
}

export const close_location_pressure_reversion: Strategy = {
    name: "Close Location Pressure Reversion",
    description: "Fades ratio moves when the rolling average of close location reaches extremes, indicating exhausted pressure.",
    defaultParams: {
        lookback: 25,
        pressureThreshold: 0.70,
    },
    paramLabels: {
        lookback: "Lookback Window",
        pressureThreshold: "Pressure Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const cl = buildCloseLocationSeries(cleanData);
        const clAvg = buildRollingAverage(cl, lookback);

        return createSignalLoop(cleanData, [clAvg], (i) => {
            const avg = clAvg[i];
            if (avg === null) return null;

            // Buy: persistent downward close location pressure is exhausting
            if (avg < (1 - p.pressureThreshold)) {
                return createBuySignal(cleanData, i, `Close location pressure buy: avg close location ${avg.toFixed(2)}`);
            }
            // Sell: persistent upward close location pressure is exhausting
            if (avg > p.pressureThreshold) {
                return createSellSignal(cleanData, i, `Close location pressure sell: avg close location ${avg.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pressureThreshold"],
    },
};
