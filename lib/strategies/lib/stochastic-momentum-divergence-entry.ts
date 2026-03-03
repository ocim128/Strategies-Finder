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
import { calculateStochastic } from "../indicators";

function isSwingLow(values: (number | null)[], index: number): boolean {
    const prev = values[index - 1];
    const curr = values[index];
    const next = values[index + 1];
    if (prev === null || curr === null || next === null) return false;
    return curr <= prev && curr < next;
}

function isSwingHigh(values: (number | null)[], index: number): boolean {
    const prev = values[index - 1];
    const curr = values[index];
    const next = values[index + 1];
    if (prev === null || curr === null || next === null) return false;
    return curr >= prev && curr > next;
}

export const stochastic_momentum_divergence_entry: Strategy = {
    name: "Stochastic Momentum Divergence Entry",
    description: "Finds short-window Stochastic divergences in extreme zones and triggers non-repainting entry signals.",
    defaultParams: {
        kPeriod: 14,
        divergenceBars: 12,
        threshold: 20,
    },
    paramLabels: {
        kPeriod: "Stochastic %K Period",
        divergenceBars: "Divergence Lookback Bars",
        threshold: "Extreme Zone Threshold",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 6) return [];

        const kPeriod = Math.max(5, Math.round(params.kPeriod ?? 14));
        const divergenceBars = Math.max(6, Math.round(params.divergenceBars ?? 12));
        const threshold = Math.max(1, Math.min(49, params.threshold ?? 20));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const { k } = calculateStochastic(highs, lows, closes, kPeriod, 3);

        return createSignalLoop(cleanData, [k], (i) => {
            const currentK = k[i] as number;
            const windowStart = Math.max(2, i - divergenceBars + 1);

            const swingLows: number[] = [];
            const swingHighs: number[] = [];

            for (let j = windowStart; j < i; j++) {
                if (j + 1 >= cleanData.length) break;
                if (isSwingLow(k, j)) swingLows.push(j);
                if (isSwingHigh(k, j)) swingHighs.push(j);
            }

            if (swingLows.length >= 2 && currentK <= threshold) {
                const prevLowIndex = swingLows[swingLows.length - 2];
                const lastLowIndex = swingLows[swingLows.length - 1];
                const priceMadeLowerLow = lows[lastLowIndex] < lows[prevLowIndex];
                const stochMadeHigherLow = (k[lastLowIndex] as number) > (k[prevLowIndex] as number);
                if (priceMadeLowerLow && stochMadeHigherLow) {
                    return createBuySignal(cleanData, i, "Stoch bullish divergence");
                }
            }

            if (swingHighs.length >= 2 && currentK >= 100 - threshold) {
                const prevHighIndex = swingHighs[swingHighs.length - 2];
                const lastHighIndex = swingHighs[swingHighs.length - 1];
                const priceMadeHigherHigh = highs[lastHighIndex] > highs[prevHighIndex];
                const stochMadeLowerHigh = (k[lastHighIndex] as number) < (k[prevHighIndex] as number);
                if (priceMadeHigherHigh && stochMadeLowerHigh) {
                    return createSellSignal(cleanData, i, "Stoch bearish divergence");
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["kPeriod", "divergenceBars", "threshold"],
    },
};

