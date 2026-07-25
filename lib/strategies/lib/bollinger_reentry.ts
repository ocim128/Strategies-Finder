import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateBollingerBands } from "../indicators";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";

const DEVIATION_MULTIPLIER = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        bollingerPeriod: Math.max(2, Math.round(Number(params.bollingerPeriod ?? 20))),
    };
}

export const bollinger_reentry: Strategy = {
    name: "Bollinger Re-entry",
    description: "Fades an extreme when price returns inside a fixed two-deviation Bollinger Band.",
    defaultParams: {
        bollingerPeriod: 20,
    },
    paramLabels: {
        bollingerPeriod: "Bollinger Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.bollingerPeriod as number;
        if (cleanData.length < period + 1) return [];

        const closes = getCloses(cleanData);
        const bands = calculateBollingerBands(closes, period, DEVIATION_MULTIPLIER);
        return createSignalLoop(cleanData, [bands.upper, bands.lower], (i) => {
            if (closes[i - 1] < bands.lower[i - 1]! && closes[i] >= bands.lower[i]!) {
                return createBuySignal(cleanData, i, "Close returned inside lower Bollinger Band");
            }
            if (closes[i - 1] > bands.upper[i - 1]! && closes[i] <= bands.upper[i]!) {
                return createSellSignal(cleanData, i, "Close returned inside upper Bollinger Band");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["bollingerPeriod"],
    },
};
