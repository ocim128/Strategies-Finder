import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildWindowGivebackRatio } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        delta_max: Math.max(0.001, Number(params.delta_max ?? 0.03)),
    };
}

export const window_giveback_velocity_arrest_reversal: Strategy = {
    name: "Window Giveback Velocity Arrest Reversal",
    description: "Catches turning bars when corrective pullback surrender velocity arrests (|delta gb| <= delta_max) at active retracement depths.",
    defaultParams: {
        delta_max: 0.03,
    },
    paramLabels: {
        delta_max: "Max Giveback Delta",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const delta_max = p.delta_max as number;
        if (cleanData.length < 20 + 1) return [];

        const closes = getCloses(cleanData);
        const gb = buildWindowGivebackRatio(cleanData, 20);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < 20) return null;
            const prevGb = gb[i - 1];
            const currGb = gb[i];
            if (prevGb === null || currGb === null) return null;

            const isArrested = currGb >= 0.25 && Math.abs(currGb - prevGb) <= delta_max;
            if (isArrested) {
                if (closes[i] > closes[i - 20] && cleanData[i].close > cleanData[i].open) {
                    return createBuySignal(cleanData, i, `Bullish velocity arrest reversal: giveback ${currGb.toFixed(3)} delta ${Math.abs(currGb - prevGb).toFixed(3)} <= ${delta_max}, bull bar in up-window`);
                }
                if (closes[i] < closes[i - 20] && cleanData[i].close < cleanData[i].open) {
                    return createSellSignal(cleanData, i, `Bearish velocity arrest reversal: giveback ${currGb.toFixed(3)} delta ${Math.abs(currGb - prevGb).toFixed(3)} <= ${delta_max}, bear bar in down-window`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["delta_max"],
    },
};
