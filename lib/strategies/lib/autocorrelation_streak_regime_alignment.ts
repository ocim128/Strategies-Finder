import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingAutoCorrelation, buildStreakCount } from "./price-action-statistics-core";

const _returns = new WeakMap<OHLCVData[], number[]>();
function getReturns(data: OHLCVData[]): number[] {
    let r = _returns.get(data);
    if (!r) {
        const closes = getCloses(data);
        r = new Array(data.length).fill(0);
        for (let i = 1; i < data.length; i++) {
            r[i] = closes[i] - closes[i - 1];
        }
        _returns.set(data, r);
    }
    return r;
}

// #COMPLETION_DRIVE: Assuming return autocorrelation streak regime alignment correctly isolates persistent institutional drifts.
// #SUGGEST_VERIFY: Verify return streak count calculation handles quiet/flat bars without resetting to incorrect states.
function normalizeAutocorrelationStreakRegimeAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 25))),
        minAutoCorr: Math.max(0.01, Math.min(0.99, Number(params.minAutoCorr ?? 0.3))),
    };
}

export const autocorrelation_streak_regime_alignment: Strategy = {
    name: "Autocorrelation Streak Regime Alignment",
    description: "Signals when price develops consecutive directional return streaks within strongly positive autocorrelation regimes.",
    defaultParams: {
        lookback: 25,
        minAutoCorr: 0.3,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minAutoCorr: "Min Autocorrelation",
    },
    normalizeParams: normalizeAutocorrelationStreakRegimeAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAutocorrelationStreakRegimeAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const returns = getReturns(cleanData);

        const autoCorr = buildRollingAutoCorrelation(returns, lookback, 1);

        // Calculate return direction flags
        const returnFlags: number[] = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const diff = closes[i] - closes[i - 1];
            returnFlags[i] = diff > 0 ? 1 : diff < 0 ? -1 : 0;
        }

        const streaks = buildStreakCount(returnFlags);

        return createSignalLoop(cleanData, [autoCorr], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentOpen = cleanData[i].open;
            const currentAuto = autoCorr[i];
            const currentStreak = streaks[i];

            if (currentAuto === null) return null;
            if (currentAuto <= p.minAutoCorr) return null;

            // Buy logic: close is above open, and streak of positive returns reaches >= 4
            if (currentClose > currentOpen && currentStreak >= 4) {
                return createBuySignal(cleanData, i, `Autocorrelation Streak Bullish (streak=${currentStreak}, autoCorr=${currentAuto.toFixed(3)})`);
            }

            // Sell logic: close is below open, and streak of negative returns reaches <= -4
            if (currentClose < currentOpen && currentStreak <= -4) {
                return createSellSignal(cleanData, i, `Autocorrelation Streak Bearish (streak=${currentStreak}, autoCorr=${currentAuto.toFixed(3)})`);
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
