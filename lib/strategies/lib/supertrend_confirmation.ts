import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateSupertrend } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";

const ATR_PERIOD = 10;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        atrMultiplier: Math.max(0.1, Number(params.atrMultiplier ?? 3)),
    };
}

export const supertrend_confirmation: Strategy = {
    name: "Supertrend Confirmation",
    description: "Signals on Supertrend direction flips using a fixed 10-bar ATR.",
    defaultParams: {
        atrMultiplier: 3,
    },
    paramLabels: {
        atrMultiplier: "ATR Multiplier",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        if (cleanData.length < ATR_PERIOD + 1) return [];

        const supertrend = calculateSupertrend(
            getHighs(cleanData),
            getLows(cleanData),
            getCloses(cleanData),
            ATR_PERIOD,
            p.atrMultiplier as number
        );
        return createSignalLoop(cleanData, [supertrend.line, supertrend.direction], (i) => {
            if (supertrend.direction[i - 1] === -1 && supertrend.direction[i] === 1) {
                return createBuySignal(cleanData, i, "Supertrend flipped bullish");
            }
            if (supertrend.direction[i - 1] === 1 && supertrend.direction[i] === -1) {
                return createSellSignal(cleanData, i, "Supertrend flipped bearish");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["atrMultiplier"],
    },
};
