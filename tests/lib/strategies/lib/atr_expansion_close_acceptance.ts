import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildCloseAcceptanceSeries, buildTrailingHighLow, buildRollingAverage } from "./price-action-frequency-core";

// #COMPLETION_DRIVE: Assuming ATR expansion over its rolling average correctly filters out low-liquidity boundary false breaks.
// #SUGGEST_VERIFY: Verify ATR and rolling average ATR do not produce zero values that distort the expansion factor multiplier.
function normalizeAtrExpansionCloseAcceptanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        atrExpansionFactor: Math.max(0.1, Number(params.atrExpansionFactor ?? 1.1)),
    };
}

export const atr_expansion_close_acceptance: Strategy = {
    name: "ATR Expansion Close Acceptance",
    description: "Signals boundary breakouts only when volatility (ATR) is expanding above its rolling average, backed by close acceptance.",
    defaultParams: {
        lookback: 30,
        atrExpansionFactor: 1.1,
    },
    paramLabels: {
        lookback: "Lookback Window",
        atrExpansionFactor: "ATR Expansion Factor",
    },
    normalizeParams: normalizeAtrExpansionCloseAcceptanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAtrExpansionCloseAcceptanceParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const atrClean = atr.map(v => v ?? 0);
        const avgAtr = buildRollingAverage(atrClean, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [highest, lowest, atr, avgAtr, closeAcceptance], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const hi = highest[i];
            const lo = lowest[i];
            const currentAtr = atr[i];
            const currentAvgAtr = avgAtr[i];
            const acc = closeAcceptance[i];

            if (hi === null || lo === null || currentAtr === null || currentAvgAtr === null || acc === null) return null;

            const threshold = p.atrExpansionFactor * currentAvgAtr;

            // Buy logic: Close is above the trailing high, positive close acceptance is registered, and ATR is greater than atrExpansionFactor times its average
            if (currentClose > hi && acc > 0 && currentAtr > threshold) {
                return createBuySignal(cleanData, i, `ATR Expanding Breakout Bullish (ATR=${currentAtr.toFixed(4)} > avg=${currentAvgAtr.toFixed(4)}, acc=${acc.toFixed(3)})`);
            }

            // Sell logic: Close is below the trailing low, negative close acceptance is registered, and ATR is greater than atrExpansionFactor times its average
            if (currentClose < lo && acc < 0 && currentAtr > threshold) {
                return createSellSignal(cleanData, i, `ATR Expanding Breakout Bearish (ATR=${currentAtr.toFixed(4)} > avg=${currentAvgAtr.toFixed(4)}, acc=${acc.toFixed(3)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "atrExpansionFactor"],
    },
};
