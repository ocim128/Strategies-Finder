import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateMFI } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        mfiPeriod: Math.max(2, Math.round(Number(params.mfiPeriod ?? 14))),
    };
}

export const mfi_midline_confirmation: Strategy = {
    name: "MFI Midline Confirmation",
    description: "Signals with Money Flow Index direction around its fixed 50 midpoint.",
    defaultParams: {
        mfiPeriod: 14,
    },
    paramLabels: {
        mfiPeriod: "MFI Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.mfiPeriod as number;
        if (cleanData.length <= period) return [];

        const mfi = calculateMFI(
            getHighs(cleanData),
            getLows(cleanData),
            getCloses(cleanData),
            getVolumes(cleanData),
            period
        );
        return createSignalLoop(cleanData, [mfi], (i) => {
            if (mfi[i]! > 50) return createBuySignal(cleanData, i, "MFI above 50");
            if (mfi[i]! < 50) return createSellSignal(cleanData, i, "MFI below 50");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["mfiPeriod"],
    },
};
