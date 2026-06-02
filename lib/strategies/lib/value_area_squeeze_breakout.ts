import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingValueArea } from "./value-area-acceptance-core";

// #COMPLETION_DRIVE: Assuming breakout of highly compressed Value Area VAH/VAL boundaries normalized by ATR signals new trends.
// #SUGGEST_VERIFY: Verify that ATR is above zero and Value Area width does not produce zero-division errors under consolidation.
function normalizeValueAreaSqueezeBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 60))),
        squeezeThreshold: Math.max(0.1, Number(params.squeezeThreshold ?? 1.2)),
    };
}

export const value_area_squeeze_breakout: Strategy = {
    name: "Value Area Squeeze Breakout",
    description: "Signals explosive breakouts from a highly compressed Value Area High/Low consensus normalized by ATR.",
    defaultParams: {
        lookback: 60,
        squeezeThreshold: 1.2,
    },
    paramLabels: {
        lookback: "Profile Lookback",
        squeezeThreshold: "Squeeze Threshold",
    },
    normalizeParams: normalizeValueAreaSqueezeBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeValueAreaSqueezeBreakoutParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const { vah, val } = buildRollingValueArea(cleanData, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        
        const closeLocation = buildCloseLocationSeries(cleanData);
        const avgCloseLoc = buildRollingAverage(closeLocation, lookback);

        return createSignalLoop(cleanData, [vah, val, atr, avgCloseLoc], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentVah = vah[i];
            const currentVal = val[i];
            const currentAtr = atr[i];
            const avgLoc = avgCloseLoc[i];

            if (currentVah === null || currentVal === null || currentAtr === null || avgLoc === null || currentAtr <= 0) return null;

            const squeezeRatio = (currentVah - currentVal) / currentAtr;

            if (squeezeRatio < p.squeezeThreshold) {
                // Buy: Close breaks above VAH, close location average is positive (avgLoc > 0.5)
                if (currentClose > currentVah && avgLoc > 0.5) {
                    return createBuySignal(cleanData, i, `VA Squeeze Breakout Bullish (squeeze=${squeezeRatio.toFixed(2)}, close=${currentClose.toFixed(2)}, VAH=${currentVah.toFixed(2)})`);
                }
                // Sell: Close breaks below VAL, close location average is negative (avgLoc < 0.5)
                if (currentClose < currentVal && avgLoc < 0.5) {
                    return createSellSignal(cleanData, i, `VA Squeeze Breakout Bearish (squeeze=${squeezeRatio.toFixed(2)}, close=${currentClose.toFixed(2)}, VAL=${currentVal.toFixed(2)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "squeezeThreshold"],
    },
};
