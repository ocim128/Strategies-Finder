import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateOBV, calculateSMA } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        obvMaPeriod: Math.max(2, Math.round(Number(params.obvMaPeriod ?? 20))),
    };
}

export const obv_signal_line_confirmation: Strategy = {
    name: "OBV Signal-Line Confirmation",
    description: "Signals with On-Balance Volume position relative to its moving-average signal line.",
    defaultParams: {
        obvMaPeriod: 20,
    },
    paramLabels: {
        obvMaPeriod: "OBV MA Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.obvMaPeriod as number;
        if (cleanData.length < period) return [];

        const obv = calculateOBV(getCloses(cleanData), getVolumes(cleanData));
        const signalLine = calculateSMA(obv, period);
        return createSignalLoop(cleanData, [signalLine], (i) => {
            if (obv[i] > signalLine[i]!) return createBuySignal(cleanData, i, "OBV above signal line");
            if (obv[i] < signalLine[i]!) return createSellSignal(cleanData, i, "OBV below signal line");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["obvMaPeriod"],
    },
};
