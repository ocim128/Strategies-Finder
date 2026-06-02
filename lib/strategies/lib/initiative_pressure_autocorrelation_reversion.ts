import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming initiative pressure autocorrelation under volatility expansion captures aggressive volume exhaustion.
// #SUGGEST_VERIFY: Verify rolling autocorrelation helper returns correct values and standard deviation bounds are causal.
function normalizeInitiativePressureAutocorrelationReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        minAutoCorr: Number(params.minAutoCorr ?? -0.4),
    };
}

export const initiative_pressure_autocorrelation_reversion: Strategy = {
    name: "Initiative Pressure Autocorrelation Reversion",
    description: "Signals reversion when highly negatively autocorrelated initiative pressure indicates exhaustion under elevated ATR volatility.",
    defaultParams: {
        lookback: 30,
        minAutoCorr: -0.4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minAutoCorr: "Min Autocorrelation",
    },
    normalizeParams: normalizeInitiativePressureAutocorrelationReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureAutocorrelationReversionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const scores = initiative.map(v => v ?? 0);
        const autoCorr = buildRollingAutoCorrelation(scores, lookback, 1);

        const atr = calculateATR(highs, lows, closes, lookback);
        const atrClean = atr.map(v => v ?? 0);
        const avgAtr = buildRollingAverage(atrClean, lookback);

        return createSignalLoop(cleanData, [initiative, autoCorr, atr, avgAtr], (i) => {
            if (i < lookback) return null;
            const currentPressure = initiative[i];
            const currentAuto = autoCorr[i];
            const currentAtr = atr[i];
            const currentAvgAtr = avgAtr[i];

            if (currentPressure === null || currentAuto === null || currentAtr === null || currentAvgAtr === null) return null;

            // Reversion condition: ATR is above its rolling average
            if (currentAtr > currentAvgAtr && currentAuto < p.minAutoCorr) {
                // Buy logic: Initiative pressure is negative
                if (currentPressure < 0) {
                    return createBuySignal(cleanData, i, `Bullish Aggression Exhaustion (pressure=${currentPressure.toFixed(3)}, autocorr=${currentAuto.toFixed(3)})`);
                }
                // Sell logic: Initiative pressure is positive
                if (currentPressure > 0) {
                    return createSellSignal(cleanData, i, `Bearish Aggression Exhaustion (pressure=${currentPressure.toFixed(3)}, autocorr=${currentAuto.toFixed(3)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minAutoCorr"],
    },
};
