import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateAroon } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getHighs,
    getLows,
} from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        aroonPeriod: Math.max(2, Math.round(Number(params.aroonPeriod ?? 25))),
    };
}

export const aroon_direction_confirmation: Strategy = {
    name: "Aroon Direction Confirmation",
    description: "Signals in the direction of the most recently renewed Aroon extreme.",
    defaultParams: {
        aroonPeriod: 25,
    },
    paramLabels: {
        aroonPeriod: "Aroon Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.aroonPeriod as number;
        if (cleanData.length < period) return [];

        const aroon = calculateAroon(getHighs(cleanData), getLows(cleanData), period);
        return createSignalLoop(cleanData, [aroon.up, aroon.down], (i) => {
            if (aroon.up[i]! > aroon.down[i]!) return createBuySignal(cleanData, i, "Aroon Up above Aroon Down");
            if (aroon.down[i]! > aroon.up[i]!) return createSellSignal(cleanData, i, "Aroon Down above Aroon Up");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["aroonPeriod"],
    },
};
