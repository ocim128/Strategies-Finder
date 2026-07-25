import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateWilliamsR } from "../indicators";
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
        williamsPeriod: Math.max(2, Math.round(Number(params.williamsPeriod ?? 14))),
    };
}

export const williams_r_midline_confirmation: Strategy = {
    name: "Williams %R Midline Confirmation",
    description: "Signals with Williams %R direction around its fixed -50 midpoint.",
    defaultParams: {
        williamsPeriod: 14,
    },
    paramLabels: {
        williamsPeriod: "Williams %R Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.williamsPeriod as number;
        if (cleanData.length < period) return [];

        const williamsR = calculateWilliamsR(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), period);
        return createSignalLoop(cleanData, [williamsR], (i) => {
            if (williamsR[i]! > -50) return createBuySignal(cleanData, i, "Williams %R above -50");
            if (williamsR[i]! < -50) return createSellSignal(cleanData, i, "Williams %R below -50");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["williamsPeriod"],
    },
};
