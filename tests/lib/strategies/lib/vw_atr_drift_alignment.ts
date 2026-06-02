import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import { calculateATR, calculateCMF } from "../indicators";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";

// #COMPLETION_DRIVE: Assuming low-volatility drift backed by steady, volume-weighted positioning creates a durable base and CMF is correctly aligned.
// #SUGGEST_VERIFY: Verify that ATR is correctly calculated and its rolling average handles early null bounds cleanly.
function normalizeVwAtrDriftAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        clsLocThreshold: Math.max(0.5, Math.min(0.99, Number(params.clsLocThreshold ?? 0.65))),
    };
}

export const vw_atr_drift_alignment: Strategy = {
    name: "Volume-Weighted ATR Drift Alignment",
    description: "Quiet, persistent price drift is captured when it occurs under compressed ATR volatility but with positive or negative volume-weighted CMF flow.",
    defaultParams: {
        lookback: 30,
        clsLocThreshold: 0.65,
    },
    paramLabels: {
        lookback: "Lookback",
        clsLocThreshold: "Close Location Threshold",
    },
    normalizeParams: normalizeVwAtrDriftAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVwAtrDriftAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const closeLocation = buildCloseLocationSeries(cleanData);
        const avgCloseLoc = buildRollingAverage(closeLocation, lookback);

        const atr = calculateATR(highs, lows, closes, lookback);
        const atrClean = atr.map(v => v ?? 0);
        const avgAtr = buildRollingAverage(atrClean, lookback);

        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);

        return createSignalLoop(cleanData, [avgCloseLoc, atr, avgAtr, cmf], (i) => {
            if (i < lookback) return null;
            const currentAvgLoc = avgCloseLoc[i];
            const currentAtr = atr[i];
            const currentAvgAtr = avgAtr[i];
            const currentCmf = cmf[i];

            if (currentAvgLoc === null || currentAtr === null || currentAvgAtr === null || currentCmf === null) return null;

            // Volatility filter: ATR is below its rolling average
            if (currentAtr < currentAvgAtr) {
                // Buy logic: Rolling average close location is above clsLocThreshold, CMF is positive
                if (currentAvgLoc > p.clsLocThreshold && currentCmf > 0) {
                    return createBuySignal(cleanData, i, `Stealth Accumulation Bullish (avgLoc=${currentAvgLoc.toFixed(3)}, CMF=${currentCmf.toFixed(3)}, ATR=${currentAtr.toFixed(4)})`);
                }
                // Sell logic: Rolling average close location is below 1 minus clsLocThreshold, CMF is negative
                if (currentAvgLoc < 1 - (p.clsLocThreshold as number) && currentCmf < 0) {
                    return createSellSignal(cleanData, i, `Stealth Distribution Bearish (avgLoc=${currentAvgLoc.toFixed(3)}, CMF=${currentCmf.toFixed(3)}, ATR=${currentAtr.toFixed(4)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "clsLocThreshold"],
    },
};
