import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateKeltnerChannels } from "../indicators";

function normalizeKeltnerExtensionReversalParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        multiplier: Math.max(0.1, Math.abs(Number(params.multiplier ?? 3))),
    };
}

export const keltner_extension_reversal: Strategy = {
    name: "Keltner Extension Reversal",
    description:
        "Fades price when an ATR-based Keltner envelope is breached by the daily tail, treating rare volatility extensions as mean-reversion candidates.",
    defaultParams: {
        lookback: 20,
        multiplier: 3,
    },
    paramLabels: {
        lookback: "Lookback",
        multiplier: "Multiplier",
    },
    normalizeParams: normalizeKeltnerExtensionReversalParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeKeltnerExtensionReversalParams(params);
        const lookback = p.lookback as number;
        const multiplier = p.multiplier as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const channels = calculateKeltnerChannels(highs, lows, closes, lookback, lookback, multiplier);

        return createSignalLoop(cleanData, [channels.upper, channels.lower], (i) => {
            const upper = channels.upper[i];
            const lower = channels.lower[i];
            if (upper === null || lower === null) return null;

            if (cleanData[i].low < lower) {
                return createBuySignal(cleanData, i, "Low below lower Keltner Band");
            }
            if (cleanData[i].high > upper) {
                return createSellSignal(cleanData, i, "High above upper Keltner Band");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "multiplier"],
    },
};
