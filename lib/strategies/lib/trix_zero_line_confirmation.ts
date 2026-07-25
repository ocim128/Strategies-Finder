import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateTRIX } from "../indicators";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        trixPeriod: Math.max(2, Math.round(Number(params.trixPeriod ?? 15))),
    };
}

export const trix_zero_line_confirmation: Strategy = {
    name: "TRIX Zero-Line Confirmation",
    description: "Signals with triple-smoothed rate-of-change direction around its fixed zero line.",
    defaultParams: {
        trixPeriod: 15,
    },
    paramLabels: {
        trixPeriod: "TRIX Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.trixPeriod as number;
        if (cleanData.length < period * 3) return [];

        const trix = calculateTRIX(getCloses(cleanData), period);
        return createSignalLoop(cleanData, [trix], (i) => {
            if (trix[i]! > 0) return createBuySignal(cleanData, i, "TRIX above zero");
            if (trix[i]! < 0) return createSellSignal(cleanData, i, "TRIX below zero");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["trixPeriod"],
    },
};
