import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateRSI } from "../indicators";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeOverextendedRsiStructuralFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        rsi_threshold: Math.max(50, Math.min(99, Number(params.rsi_threshold ?? 80))),
    };
}

export const overextended_rsi_structural_fade: Strategy = {
    name: "Overextended RSI Structural Fade",
    description:
        "Fades RSI extremes only when price is simultaneously pressing an inclusive trailing range boundary, targeting local structural overextension.",
    defaultParams: {
        lookback: 20,
        rsi_threshold: 80,
    },
    paramLabels: {
        lookback: "Lookback",
        rsi_threshold: "RSI Threshold",
    },
    normalizeParams: normalizeOverextendedRsiStructuralFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeOverextendedRsiStructuralFadeParams(params);
        const lookback = p.lookback as number;
        const rsiThreshold = p.rsi_threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const rsi = calculateRSI(closes, lookback);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, true);
        const oversoldThreshold = 100 - rsiThreshold;

        return createSignalLoop(cleanData, [rsi, highest, lowest], (i) => {
            const rsiValue = rsi[i];
            const highestValue = highest[i];
            const lowestValue = lowest[i];
            if (rsiValue === null || highestValue === null || lowestValue === null) return null;

            if (rsiValue < oversoldThreshold && cleanData[i].low <= lowestValue) {
                return createBuySignal(cleanData, i, `RSI ${rsiValue.toFixed(1)} at trailing low`);
            }
            if (rsiValue > rsiThreshold && cleanData[i].high >= highestValue) {
                return createSellSignal(cleanData, i, `RSI ${rsiValue.toFixed(1)} at trailing high`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rsi_threshold"],
    },
};
