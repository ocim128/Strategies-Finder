import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateDeMarker } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(2, Math.round(Number(params.period ?? 14))),
    };
}

export const demarker_midline_confirmation: Strategy = {
    name: "DeMarker Midline Confirmation",
    description: "Signals with the current DeMarker value above or below its fixed 0.50 midpoint.",
    defaultParams: {
        period: 14,
    },
    paramLabels: {
        period: "DeMarker Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const period = normalizeParams(params).period as number;
        const demarker = calculateDeMarker(cleanData, period);
        return createCurrentBarSignalLoop(cleanData, [demarker], (i) => {
            if (demarker[i]! > 0.5) return createBuySignal(cleanData, i, "DeMarker above 0.50");
            if (demarker[i]! < 0.5) return createSellSignal(cleanData, i, "DeMarker below 0.50");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
