import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateQstick } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(2, Math.round(Number(params.period ?? 14))),
    };
}

export const qstick_zero_line_confirmation: Strategy = {
    name: "Qstick Zero-Line Confirmation",
    description: "Signals from the current trailing average of candle bodies around zero.",
    defaultParams: {
        period: 14,
    },
    paramLabels: {
        period: "Qstick Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const period = normalizeParams(params).period as number;
        const qstick = calculateQstick(cleanData, period);
        return createCurrentBarSignalLoop(cleanData, [qstick], (i) => {
            if (qstick[i]! > 0) return createBuySignal(cleanData, i, "Qstick above zero");
            if (qstick[i]! < 0) return createSellSignal(cleanData, i, "Qstick below zero");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
