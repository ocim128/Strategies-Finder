import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingStdDev, buildStreakCount } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming standard deviation bands around VWAP represent true velocity boundaries.
// #SUGGEST_VERIFY: Verify streak count logic reset behavior when close acceptance changes sign or falls to zero.
function normalizeVwapBandAcceptancePersistenceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minStreak: Math.max(2, Math.round(Number(params.minStreak ?? 5))),
    };
}

export const vwap_band_acceptance_persistence: Strategy = {
    name: "VWAP Band Acceptance Persistence",
    description: "Signals when close price accepts outside rolling VWAP standard deviation bands for a consecutive streak.",
    defaultParams: {
        lookback: 30,
        minStreak: 5,
    },
    paramLabels: {
        lookback: "VWAP Lookback",
        minStreak: "Min Streak Duration",
    },
    normalizeParams: normalizeVwapBandAcceptancePersistenceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVwapBandAcceptancePersistenceParams(params);
        const lookback = p.lookback as number;
        const minStreak = p.minStreak as number;
        if (cleanData.length < lookback + minStreak + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
        const stddev = buildRollingStdDev(closes, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        const flags = closeAcceptance.map(v => v > 0 ? 1 : v < 0 ? -1 : 0);
        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [vwap, stddev], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentVwap = vwap[i];
            const currentStd = stddev[i];
            const currentStreak = streaks[i];

            if (currentVwap === null || currentStd === null) return null;

            const upperBand = currentVwap + 1.0 * currentStd;
            const lowerBand = currentVwap - 1.0 * currentStd;

            // Buy: Close is above VWAP plus 1.0 standard deviations, and positive close acceptance streak reaches minStreak
            if (currentClose > upperBand && currentStreak >= minStreak) {
                return createBuySignal(cleanData, i, `VWAP Band Acceptance Persistence Bullish (streak=${currentStreak}, close=${currentClose.toFixed(2)}, upper=${upperBand.toFixed(2)})`);
            }

            // Sell: Close is below VWAP minus 1.0 standard deviations, and negative close acceptance streak reaches minStreak
            if (currentClose < lowerBand && currentStreak <= -minStreak) {
                return createSellSignal(cleanData, i, `VWAP Band Acceptance Persistence Bearish (streak=${currentStreak}, close=${currentClose.toFixed(2)}, lower=${lowerBand.toFixed(2)})`);
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
