import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateRSI } from "../indicators";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        rsiPeriod: Math.max(2, Math.round(Number(params.rsiPeriod ?? 14))),
    };
}

export const rsi_midline_confirmation: Strategy = {
    name: "RSI Midline Confirmation",
    description: "Signals with RSI direction around its fixed 50 midpoint.",
    defaultParams: {
        rsiPeriod: 14,
    },
    paramLabels: {
        rsiPeriod: "RSI Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.rsiPeriod as number;
        if (cleanData.length <= period) return [];

        const rsi = calculateRSI(getCloses(cleanData), period);
        return createSignalLoop(cleanData, [rsi], (i) => {
            if (rsi[i]! > 50) return createBuySignal(cleanData, i, "RSI above 50");
            if (rsi[i]! < 50) return createSellSignal(cleanData, i, "RSI below 50");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["rsiPeriod"],
    },
};
