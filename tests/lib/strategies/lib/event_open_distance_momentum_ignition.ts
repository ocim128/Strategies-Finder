import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import { calculateATR, calculateCMF } from "../indicators";

// #COMPLETION_DRIVE: Assuming event opening anchor is data[0].open and is stable throughout the execution series.
// #SUGGEST_VERIFY: Check behavior at index 0 and ensure ATR does not produce zero-division errors under compression.
function normalizeEventOpenDistanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
        distanceThreshold: Math.max(0.1, Number(params.distanceThreshold ?? 2.2)),
    };
}

export const event_open_distance_momentum_ignition: Strategy = {
    name: "Event Open Distance Momentum Ignition",
    description: "Captures early session momentum when price establishes a clear ATR-normalized distance from the opening anchor, gated by Chaikin Money Flow.",
    defaultParams: {
        lookback: 50,
        distanceThreshold: 2.2,
    },
    paramLabels: {
        lookback: "Lookback (ATR/CMF)",
        distanceThreshold: "Distance Threshold (ATR)",
    },
    normalizeParams: normalizeEventOpenDistanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEventOpenDistanceParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const eventOpen = cleanData[0].open;
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const atr = calculateATR(highs, lows, closes, lookback);
        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);

        return createSignalLoop(cleanData, [atr, cmf], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentAtr = atr[i];
            const currentCmf = cmf[i];

            if (currentAtr === null || currentCmf === null || currentAtr <= 0) return null;

            const distance = currentClose - eventOpen;
            const normalizedDistance = distance / currentAtr;

            // Bullish: Close is above event open by more than distanceThreshold * ATR, while CMF is positive
            if (normalizedDistance > (p.distanceThreshold as number) && currentCmf > 0) {
                return createBuySignal(cleanData, i, `Event Open Distance Bullish (dist=${normalizedDistance.toFixed(2)}x ATR, CMF=${currentCmf.toFixed(3)})`);
            }

            // Bearish: Close is below event open by more than distanceThreshold * ATR, while CMF is negative
            if (normalizedDistance < -(p.distanceThreshold as number) && currentCmf < 0) {
                return createSellSignal(cleanData, i, `Event Open Distance Bearish (dist=${normalizedDistance.toFixed(2)}x ATR, CMF=${currentCmf.toFixed(3)})`);
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
