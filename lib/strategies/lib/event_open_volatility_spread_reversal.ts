import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from "../strategy-helpers";
import { calculateATR, calculateCMF } from "../indicators";
import { buildRollingAverage } from "./price-action-frequency-core";

// #COMPLETION_DRIVE: Assuming event opening anchor is data[0].open and is stable throughout the execution series.
// #SUGGEST_VERIFY: Check behavior at index 0 and ensure ATR does not produce zero-division errors under compression.
function normalizeEventOpenVolatilitySpreadReversalParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
        distThreshold: Math.max(0.1, Number(params.distThreshold ?? 2.0)),
    };
}

export const event_open_volatility_spread_reversal: Strategy = {
    name: "Event Open Volatility Spread Reversal",
    description: "Signals price overextensions from the event open price once ATR compresses and opposite volume accumulation CMF diverges.",
    defaultParams: {
        lookback: 50,
        distThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        distThreshold: "ATR Distance Threshold",
    },
    normalizeParams: normalizeEventOpenVolatilitySpreadReversalParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEventOpenVolatilitySpreadReversalParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const eventOpen = cleanData[0].open;
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const atr = calculateATR(highs, lows, closes, lookback);
        const atrClean = atr.map(v => v ?? 0);
        const avgAtr = buildRollingAverage(atrClean, lookback);
        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);

        return createSignalLoop(cleanData, [atr, avgAtr, cmf], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentAtr = atr[i];
            const currentAvgAtr = avgAtr[i];
            const currentCmf = cmf[i];

            if (currentAtr === null || currentAvgAtr === null || currentCmf === null || currentAtr <= 0) return null;

            const distance = currentClose - eventOpen;
            const normalizedDistance = distance / currentAtr;

            // Reversion condition: ATR is below its rolling average
            if (currentAtr < currentAvgAtr) {
                // Buy: Close is below event open by more than distThreshold * ATR, CMF is positive (accumulation)
                if (normalizedDistance < -(p.distThreshold as number) && currentCmf > 0) {
                    return createBuySignal(cleanData, i, `Event Open Volatility Spread Reversal Bullish (dist=${normalizedDistance.toFixed(2)}x ATR, CMF=${currentCmf.toFixed(3)})`);
                }
                // Sell: Close is above event open by more than distThreshold * ATR, CMF is negative (distribution)
                if (normalizedDistance > p.distThreshold && currentCmf < 0) {
                    return createSellSignal(cleanData, i, `Event Open Volatility Spread Reversal Bearish (dist=${normalizedDistance.toFixed(2)}x ATR, CMF=${currentCmf.toFixed(3)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "distThreshold"],
    },
};
