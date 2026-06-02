import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { calculateATR } from "../indicators";

// #COMPLETION_DRIVE: Assuming event opening anchor is data[0].open and is stable throughout the execution series.
// #SUGGEST_VERIFY: Check behavior at index 0 and ensure ATR does not produce zero-division errors under compression.
function normalizeVolatilityGatedEventOpenDistanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
        distanceThreshold: Math.max(0.1, Number(params.distanceThreshold ?? 3.0)),
    };
}

export const volatility_gated_event_open_distance: Strategy = {
    name: "Volatility Gated Event Open Distance",
    description: "Confirms a clean breakout from the opening session anchor by gating price distance with rolling ATR volatility.",
    defaultParams: {
        lookback: 50,
        distanceThreshold: 3.0,
    },
    paramLabels: {
        lookback: "ATR Lookback",
        distanceThreshold: "Distance Threshold (ATR)",
    },
    normalizeParams: normalizeVolatilityGatedEventOpenDistanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilityGatedEventOpenDistanceParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const eventOpen = cleanData[0].open;
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const atr = calculateATR(highs, lows, closes, lookback);

        return createSignalLoop(cleanData, [atr], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentAtr = atr[i];

            if (currentAtr === null || currentAtr <= 0) return null;

            const distance = currentClose - eventOpen;
            const normalizedDistance = distance / currentAtr;

            // Buy logic: Distance normalized by ATR is greater than distanceThreshold
            if (normalizedDistance > p.distanceThreshold) {
                return createBuySignal(cleanData, i, `Event Open Breakout Bullish (dist=${normalizedDistance.toFixed(2)}x ATR, ATR=${currentAtr.toFixed(4)})`);
            }

            // Sell logic: Distance normalized by ATR is less than minus distanceThreshold
            if (normalizedDistance < -(p.distanceThreshold as number)) {
                return createSellSignal(cleanData, i, `Event Open Breakout Bearish (dist=${normalizedDistance.toFixed(2)}x ATR, ATR=${currentAtr.toFixed(4)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "distanceThreshold"],
    },
};
