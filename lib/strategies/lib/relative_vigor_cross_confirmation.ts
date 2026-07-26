import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateRelativeVigor } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(2, Math.round(Number(params.period ?? 10))),
    };
}

export const relative_vigor_cross_confirmation: Strategy = {
    name: "Relative Vigor Cross Confirmation",
    description: "Signals from current RVI position relative to its fixed causal four-bar signal line.",
    defaultParams: {
        period: 10,
    },
    paramLabels: {
        period: "RVI Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const period = normalizeParams(params).period as number;
        const rvi = calculateRelativeVigor(cleanData, period);
        return createCurrentBarSignalLoop(cleanData, [rvi.vigor, rvi.signal], (i) => {
            if (rvi.vigor[i]! > rvi.signal[i]!) return createBuySignal(cleanData, i, "RVI above signal line");
            if (rvi.vigor[i]! < rvi.signal[i]!) return createSellSignal(cleanData, i, "RVI below signal line");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
