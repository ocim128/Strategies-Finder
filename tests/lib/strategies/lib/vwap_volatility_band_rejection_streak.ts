import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import { calculateVWAP, calculateATR } from "../indicators";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming rejection of price extremes relative to standard deviation bands of the VWAP produces reliable swing setups.
// #SUGGEST_VERIFY: Verify streak tracking is causal and does not contain off-by-one future leaks.
function normalizeVwapVolatilityBandRejectionStreakParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        minStreak: Math.max(2, Math.round(Number(params.minStreak ?? 4))),
    };
}

export const vwap_volatility_band_rejection_streak: Strategy = {
    name: "VWAP Volatility Band Rejection Streak",
    description: "Signals price extreme rejection from VWAP volatility bands followed by consecutive close acceptance back toward the VWAP center.",
    defaultParams: {
        lookback: 40,
        minStreak: 4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minStreak: "Min Acceptance Streak",
    },
    normalizeParams: normalizeVwapVolatilityBandRejectionStreakParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVwapVolatilityBandRejectionStreakParams(params);
        const lookback = p.lookback as number;
        const minStreak = p.minStreak as number;
        if (cleanData.length < lookback + 10) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        const flags = closeAcceptance.map(v => v > 0 ? 1 : v < 0 ? -1 : 0);
        const streaks = buildStreakCount(flags);

        // Pre-build touch indicators within a trailing 5-bar window
        const lowerBandTouch: boolean[] = new Array(cleanData.length).fill(false);
        const upperBandTouch: boolean[] = new Array(cleanData.length).fill(false);

        for (let i = 0; i < cleanData.length; i++) {
            let touchedLower = false;
            let touchedUpper = false;
            const start = Math.max(0, i - 4);
            for (let j = start; j <= i; j++) {
                const v = vwap[j];
                const a = atr[j];
                if (v === null || a === null) continue;
                const lower = v - 1.5 * a;
                const upper = v + 1.5 * a;
                if (lows[j] <= lower) touchedLower = true;
                if (highs[j] >= upper) touchedUpper = true;
            }
            lowerBandTouch[i] = touchedLower;
            upperBandTouch[i] = touchedUpper;
        }

        return createSignalLoop(cleanData, [vwap, atr], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentVwap = vwap[i];
            const currentStreak = streaks[i];

            if (currentVwap === null) return null;

            // Buy logic: Close has recently touched the lower VWAP volatility band and positive close acceptance reaches minStreak
            if (lowerBandTouch[i] && currentStreak >= minStreak && currentClose < currentVwap) {
                return createBuySignal(cleanData, i, `VWAP Lower Volatility Band Rejection (streak=${currentStreak}, close=${currentClose.toFixed(2)}, VWAP=${currentVwap.toFixed(2)})`);
            }

            // Sell logic: Close has recently touched the upper VWAP volatility band and negative close acceptance reaches minStreak
            if (upperBandTouch[i] && currentStreak <= -minStreak && currentClose > currentVwap) {
                return createSellSignal(cleanData, i, `VWAP Upper Volatility Band Rejection (streak=${currentStreak}, close=${currentClose.toFixed(2)}, VWAP=${currentVwap.toFixed(2)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minStreak"],
    },
};
