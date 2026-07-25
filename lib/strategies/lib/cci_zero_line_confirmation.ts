import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateCCI } from "../indicators";
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
        cciPeriod: Math.max(2, Math.round(Number(params.cciPeriod ?? 20))),
    };
}

export const cci_zero_line_confirmation: Strategy = {
    name: "CCI Zero-Line Confirmation",
    description: "Signals with Commodity Channel Index direction around its fixed zero line.",
    defaultParams: {
        cciPeriod: 20,
    },
    paramLabels: {
        cciPeriod: "CCI Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.cciPeriod as number;
        if (cleanData.length < period) return [];

        const cci = calculateCCI(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), period);
        return createSignalLoop(cleanData, [cci], (i) => {
            if (cci[i]! > 0) return createBuySignal(cleanData, i, "CCI above zero");
            if (cci[i]! < 0) return createSellSignal(cleanData, i, "CCI below zero");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["cciPeriod"],
    },
};
