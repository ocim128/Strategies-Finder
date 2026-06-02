import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildRollingValueArea } from "./value-area-acceptance-core";

// #COMPLETION_DRIVE: Assuming Value Area squeeze is properly normalized by ATR and handles extremely low ATR values gracefully.
// #SUGGEST_VERIFY: Ensure division by ATR does not trigger division-by-zero errors when ATR is exceptionally low.
function normalizeVaSqueezeVolumeThrustParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
        squeezeThreshold: Math.max(0.1, Number(params.squeezeThreshold ?? 1.2)),
    };
}

export const va_squeeze_volume_thrust: Strategy = {
    name: "Value Area Squeeze Volume Thrust",
    description: "Signals breakouts from a highly compressed volume Value Area when confirmed by an extreme volume Z-score thrust.",
    defaultParams: {
        lookback: 50,
        squeezeThreshold: 1.2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        squeezeThreshold: "Squeeze Threshold",
    },
    normalizeParams: normalizeVaSqueezeVolumeThrustParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVaSqueezeVolumeThrustParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const { vah, val } = buildRollingValueArea(cleanData, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const volZ = buildRollingZScore(volumes, lookback);

        return createSignalLoop(cleanData, [vah, val, atr, volZ], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentVah = vah[i];
            const currentVal = val[i];
            const currentAtr = atr[i];
            const currentVolZ = volZ[i];

            if (currentVah === null || currentVal === null || currentAtr === null || currentVolZ === null || currentAtr <= 0) return null;

            const squeezeRatio = (currentVah - currentVal) / currentAtr;

            if (squeezeRatio < p.squeezeThreshold && currentVolZ > 1.8) {
                // Buy: Close is above VAH
                if (currentClose > currentVah) {
                    return createBuySignal(cleanData, i, `VA Squeeze Breakout Bullish (squeeze=${squeezeRatio.toFixed(2)}, volZ=${currentVolZ.toFixed(2)})`);
                }
                // Sell: Close is below VAL
                if (currentClose < currentVal) {
                    return createSellSignal(cleanData, i, `VA Squeeze Breakout Bearish (squeeze=${squeezeRatio.toFixed(2)}, volZ=${currentVolZ.toFixed(2)})`);
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
