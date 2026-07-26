import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateChandeForecastOscillator } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(2, Math.round(Number(params.period ?? 20))),
    };
}

export const chande_forecast_oscillator_confirmation: Strategy = {
    name: "Chande Forecast Oscillator Confirmation",
    description: "Signals from current close displacement versus the endpoint of a trailing regression.",
    defaultParams: {
        period: 20,
    },
    paramLabels: {
        period: "CFO Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const period = normalizeParams(params).period as number;
        const cfo = calculateChandeForecastOscillator(cleanData, period);
        return createCurrentBarSignalLoop(cleanData, [cfo], (i) => {
            if (cfo[i]! > 0) return createBuySignal(cleanData, i, "CFO above zero");
            if (cfo[i]! < 0) return createSellSignal(cleanData, i, "CFO below zero");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
