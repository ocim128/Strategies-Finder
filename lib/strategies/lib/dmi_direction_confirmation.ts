import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateDMI } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        dmiPeriod: Math.max(2, Math.round(Number(params.dmiPeriod ?? 14))),
    };
}

export const dmi_direction_confirmation: Strategy = {
    name: "DMI Direction Confirmation",
    description: "Signals with the dominant directional movement line without an ADX threshold.",
    defaultParams: {
        dmiPeriod: 14,
    },
    paramLabels: {
        dmiPeriod: "DMI Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.dmiPeriod as number;
        if (cleanData.length <= period) return [];

        const dmi = calculateDMI(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), period);
        return createSignalLoop(cleanData, [dmi.plus, dmi.minus], (i) => {
            if (dmi.plus[i]! > dmi.minus[i]!) return createBuySignal(cleanData, i, "+DI above -DI");
            if (dmi.minus[i]! > dmi.plus[i]!) return createSellSignal(cleanData, i, "-DI above +DI");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["dmiPeriod"],
    },
};
