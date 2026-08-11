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
import { calculateATR } from "../indicators";

const OVERSHOOT_ATR = 3.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 20))),
    };
}

export const atr_normalized_return_reversion: Strategy = {
    name: "ATR-Normalized Return Reversion",
    description: "Fades multi-bar close-to-close moves that exceed three ATRs of the current volatility scale.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Move & ATR Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);

        return createSignalLoop(cleanData, [atr], (i) => {
            const atrNow = atr[i];
            if (atrNow === null || atrNow <= 0 || i < lookback) return null;

            const displacement = (closes[i] - closes[i - lookback]) / atrNow;

            if (displacement < -OVERSHOOT_ATR) {
                return createBuySignal(cleanData, i, `ATR-return buy: ${lookback}-bar move ${displacement.toFixed(2)} ATR below equilibrium`);
            }
            if (displacement > OVERSHOOT_ATR) {
                return createSellSignal(cleanData, i, `ATR-return sell: ${lookback}-bar move ${displacement.toFixed(2)} ATR above equilibrium`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
