import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming fast/slow efficiency ratio divergence correctly identifies explosive momentum breakouts.
// #SUGGEST_VERIFY: Verify slow efficiency ratio does not trigger division by zero when price is flat or consolidates.
function normalizeDualTimeframeEfficiencyRatioSpreadParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        fastLookback: Math.max(2, Math.round(Number(params.fastLookback ?? 20))),
        slowLookback: Math.max(5, Math.round(Number(params.slowLookback ?? 80))),
    };
}

export const dual_timeframe_efficiency_ratio_spread: Strategy = {
    name: "Dual Timeframe Efficiency Ratio Spread",
    description: "Captures transitions from high-noise consolidation to explosive momentum breakouts using the ratio of fast to slow path efficiency.",
    defaultParams: {
        fastLookback: 20,
        slowLookback: 80,
    },
    paramLabels: {
        fastLookback: "Fast Lookback",
        slowLookback: "Slow Lookback",
    },
    normalizeParams: normalizeDualTimeframeEfficiencyRatioSpreadParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDualTimeframeEfficiencyRatioSpreadParams(params);
        const fastLookback = p.fastLookback as number;
        const slowLookback = p.slowLookback as number;
        const maxLookback = Math.max(fastLookback, slowLookback);
        if (cleanData.length < maxLookback + 5) return [];

        const fastEff = buildEfficiencyRatio(cleanData, fastLookback);
        const slowEff = buildEfficiencyRatio(cleanData, slowLookback);

        return createSignalLoop(cleanData, [fastEff, slowEff], (i) => {
            if (i < maxLookback) return null;
            const currentClose = cleanData[i].close;
            const currentOpen = cleanData[i].open;
            const fe = fastEff[i];
            const se = slowEff[i];

            if (fe === null || se === null || se <= 0) return null;

            const ratio = fe / se;

            if (ratio > 1.8) {
                // Buy: Close price is above open
                if (currentClose > currentOpen) {
                    return createBuySignal(cleanData, i, `Dual Efficiency Breakout Bullish (ratio=${ratio.toFixed(2)}, fast=${fe.toFixed(2)}, slow=${se.toFixed(2)})`);
                }
                // Sell: Close price is below open
                if (currentClose < currentOpen) {
                    return createSellSignal(cleanData, i, `Dual Efficiency Breakout Bearish (ratio=${ratio.toFixed(2)}, fast=${fe.toFixed(2)}, slow=${se.toFixed(2)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fastLookback", "slowLookback"],
    },
};
