import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateCoppockCurve } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        smoothingPeriod: Math.max(2, Math.round(Number(params.smoothingPeriod ?? 10))),
    };
}

export const coppock_zero_line_confirmation: Strategy = {
    name: "Coppock Zero-Line Confirmation",
    description: "Signals from the current fixed 11/14 ROC Coppock Curve around zero.",
    defaultParams: {
        smoothingPeriod: 10,
    },
    paramLabels: {
        smoothingPeriod: "Coppock Smoothing Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const smoothingPeriod = normalizeParams(params).smoothingPeriod as number;
        const coppock = calculateCoppockCurve(cleanData, smoothingPeriod);
        return createCurrentBarSignalLoop(cleanData, [coppock], (i) => {
            if (coppock[i]! > 0) return createBuySignal(cleanData, i, "Coppock Curve above zero");
            if (coppock[i]! < 0) return createSellSignal(cleanData, i, "Coppock Curve below zero");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["smoothingPeriod"],
    },
};
