import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateChandeMomentumOscillator } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(2, Math.round(Number(params.period ?? 14))),
    };
}

export const chande_momentum_midline_confirmation: Strategy = {
    name: "Chande Momentum Midline Confirmation",
    description: "Signals with the current Chande Momentum Oscillator above or below its zero midpoint.",
    defaultParams: {
        period: 14,
    },
    paramLabels: {
        period: "CMO Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const period = normalizeParams(params).period as number;
        const cmo = calculateChandeMomentumOscillator(cleanData, period);
        return createCurrentBarSignalLoop(cleanData, [cmo], (i) => {
            if (cmo[i]! > 0) return createBuySignal(cleanData, i, "CMO above zero");
            if (cmo[i]! < 0) return createSellSignal(cleanData, i, "CMO below zero");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
