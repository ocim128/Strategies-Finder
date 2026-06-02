import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingValueArea } from "./value-area-acceptance-core";

// #COMPLETION_DRIVE: Assuming Value Area High and Value Area Low squeeze is properly normalized by ATR and handles extremely low ATR values gracefully.
// #SUGGEST_VERIFY: Ensure division by ATR does not trigger division-by-zero errors when ATR is exceptionally low.
function normalizeValueAreaDensityBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 60))),
        squeezeRatio: Math.max(0.1, Number(params.squeezeRatio ?? 1.1)),
    };
}

export const value_area_density_breakout: Strategy = {
    name: "Value Area Density Breakout",
    description: "Signals breakouts from a highly compressed Value Area High/Low region when confirmed by close acceptance outside the range.",
    defaultParams: {
        lookback: 60,
        squeezeRatio: 1.1,
    },
    paramLabels: {
        lookback: "Lookback Window",
        squeezeRatio: "Squeeze Ratio Threshold",
    },
    normalizeParams: normalizeValueAreaDensityBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeValueAreaDensityBreakoutParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const { vah, val } = buildRollingValueArea(cleanData, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [vah, val, atr, closeAcceptance], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentVah = vah[i];
            const currentVal = val[i];
            const currentAtr = atr[i];
            const acc = closeAcceptance[i];

            if (currentVah === null || currentVal === null || currentAtr === null || acc === null || currentAtr <= 0) return null;

            const ratio = (currentVah - currentVal) / currentAtr;

            if (ratio < p.squeezeRatio) {
                // Buy: close price accepts above VAH (acc > 0)
                if (currentClose > currentVah && acc > 0) {
                    return createBuySignal(cleanData, i, `Value Area Density Breakout Bullish (ratio=${ratio.toFixed(2)}, close=${currentClose.toFixed(2)}, VAH=${currentVah.toFixed(2)})`);
                }
                // Sell: close price accepts below VAL (acc < 0)
                if (currentClose < currentVal && acc < 0) {
                    return createSellSignal(cleanData, i, `Value Area Density Breakout Bearish (ratio=${ratio.toFixed(2)}, close=${currentClose.toFixed(2)}, VAL=${currentVal.toFixed(2)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "squeezeRatio"],
    },
};
