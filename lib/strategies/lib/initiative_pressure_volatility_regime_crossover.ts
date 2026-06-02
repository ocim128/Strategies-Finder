import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming initiative pressure divided by ATR correctly normalizes dynamic momentum against volatility.
// #SUGGEST_VERIFY: Verify ATR value is not zero or too small to avoid divide-by-zero errors.
function normalizeInitiativePressureVolatilityRegimeCrossoverParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        pressureFactor: Math.max(0.1, Number(params.pressureFactor ?? 2.0)),
    };
}

export const initiative_pressure_volatility_regime_crossover: Strategy = {
    name: "Initiative Pressure Volatility Regime Crossover",
    description: "Signals rolling median crossovers only when volatility-normalized initiative pressure confirms aggressive buyer or seller commitment.",
    defaultParams: {
        lookback: 40,
        pressureFactor: 2.0,
    },
    paramLabels: {
        lookback: "Lookback",
        pressureFactor: "Pressure Factor",
    },
    normalizeParams: normalizeInitiativePressureVolatilityRegimeCrossoverParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureVolatilityRegimeCrossoverParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const median = buildRollingMedian(closes, lookback);
        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);

        return createSignalLoop(cleanData, [median, initiative, atr], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const prevClose = closes[i - 1];
            const currentMedian = median[i];
            const prevMedian = median[i - 1];
            const currentPressure = initiative[i];
            const currentAtr = atr[i];

            if (currentMedian === null || prevMedian === null || currentPressure === null || currentAtr === null || currentAtr <= 0) return null;

            const normalizedPressure = currentPressure / currentAtr;

            // Buy: Close price crosses above rolling median while normalized pressure > pressureFactor
            if (prevClose <= prevMedian && currentClose > currentMedian && normalizedPressure > p.pressureFactor) {
                return createBuySignal(cleanData, i, `Initiative Crossover Bullish (normalizedPressure=${normalizedPressure.toFixed(2)}, ATR=${currentAtr.toFixed(4)})`);
            }

            // Sell: Close price crosses below rolling median while normalized pressure < -pressureFactor
            if (prevClose >= prevMedian && currentClose < currentMedian && normalizedPressure < -(p.pressureFactor as number)) {
                return createSellSignal(cleanData, i, `Initiative Crossover Bearish (normalizedPressure=${normalizedPressure.toFixed(2)}, ATR=${currentAtr.toFixed(4)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pressureFactor"],
    },
};
