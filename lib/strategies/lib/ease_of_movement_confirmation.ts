import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateEaseOfMovement } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(2, Math.round(Number(params.period ?? 14))),
    };
}

export const ease_of_movement_confirmation: Strategy = {
    name: "Ease of Movement Confirmation",
    description: "Signals from current smoothed price displacement relative to range and volume.",
    defaultParams: {
        period: 14,
    },
    paramLabels: {
        period: "EOM Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const period = normalizeParams(params).period as number;
        const eom = calculateEaseOfMovement(cleanData, period);
        return createCurrentBarSignalLoop(cleanData, [eom], (i) => {
            if (eom[i]! > 0) return createBuySignal(cleanData, i, "Ease of Movement above zero");
            if (eom[i]! < 0) return createSellSignal(cleanData, i, "Ease of Movement below zero");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
