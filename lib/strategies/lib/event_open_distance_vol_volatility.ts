import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRollingAverage } from "./price-action-frequency-core";

// #COMPLETION_DRIVE: Assuming event opening anchor is data[0].open and is stable throughout the execution series.
// #SUGGEST_VERIFY: Check behavior at index 0 and ensure ATR does not produce zero-division errors under compression.
function normalizeEventOpenDistanceVolVolatilityParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 60))),
        normDistanceThreshold: Math.max(0.1, Number(params.normDistanceThreshold ?? 2.5)),
    };
}

export const event_open_distance_vol_volatility: Strategy = {
    name: "Event Open Distance Vol Volatility Alignment",
    description: "Captures early session breakouts by double-normalizing price distance from the event open anchor by both rolling average volume and ATR.",
    defaultParams: {
        lookback: 60,
        normDistanceThreshold: 2.5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        normDistanceThreshold: "Normalized Distance Threshold",
    },
    normalizeParams: normalizeEventOpenDistanceVolVolatilityParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEventOpenDistanceVolVolatilityParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const eventOpen = cleanData[0].open;
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const avgVol = buildRollingAverage(volumes, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);

        return createSignalLoop(cleanData, [avgVol, atr], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentAvgVol = avgVol[i];
            const currentAtr = atr[i];

            if (currentAvgVol === null || currentAtr === null || currentAvgVol <= 0 || currentAtr <= 0) return null;

            const priceDistance = currentClose - eventOpen;
            const normalizationFactor = currentAvgVol * currentAtr;
            if (normalizationFactor <= 0) return null;

            const normalizedDistance = priceDistance / normalizationFactor;

            // Buy: Price distance normalized by volume*ATR is above threshold
            if (normalizedDistance > p.normDistanceThreshold) {
                return createBuySignal(cleanData, i, `Event Open Dist Vol-Volatility Bullish (dist=${normalizedDistance.toFixed(4)}, ATR=${currentAtr.toFixed(4)}, Vol=${currentAvgVol.toFixed(0)})`);
            }

            // Sell: Price distance normalized by volume*ATR is below minus threshold
            if (normalizedDistance < -(p.normDistanceThreshold as number)) {
                return createSellSignal(cleanData, i, `Event Open Dist Vol-Volatility Bearish (dist=${normalizedDistance.toFixed(4)}, ATR=${currentAtr.toFixed(4)}, Vol=${currentAvgVol.toFixed(0)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "normDistanceThreshold"],
    },
};
