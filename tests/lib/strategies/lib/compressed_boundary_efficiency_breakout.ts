import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming trailing boundary breakout coupled with close acceptance and efficiency ratio is a reliable momentum indicator.
// #SUGGEST_VERIFY: Check standard testing with manual array comparison and assert zero future leakage.
function normalizeCompressedBoundaryEfficiencyBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        minEfficiency: Math.max(0.01, Math.min(0.99, Number(params.minEfficiency ?? 0.7))),
    };
}

export const compressed_boundary_efficiency_breakout: Strategy = {
    name: "Compressed Boundary Efficiency Breakout",
    description: "Captures breakouts from tight trailing boundaries at their earliest moment when confirmed by positive close acceptance and high path efficiency.",
    defaultParams: {
        lookback: 30,
        minEfficiency: 0.7,
    },
    paramLabels: {
        lookback: "Lookback",
        minEfficiency: "Min Efficiency",
    },
    normalizeParams: normalizeCompressedBoundaryEfficiencyBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCompressedBoundaryEfficiencyBreakoutParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [highest, lowest, efficiency, closeAcceptance], (i) => {
            const currentClose = closes[i];
            const hi = highest[i];
            const lo = lowest[i];
            const eff = efficiency[i];
            const acc = closeAcceptance[i];

            if (hi === null || lo === null || eff === null || acc === null) return null;
            if (eff <= p.minEfficiency) return null;

            // Buy logic: Close breaks above trailing high, close acceptance is positive, and efficiency is high
            if (currentClose > hi && acc > 0) {
                return createBuySignal(cleanData, i, `Compressed Boundary Breakout Bullish (close=${currentClose}, hi=${hi}, eff=${eff.toFixed(3)}, acc=${acc.toFixed(3)})`);
            }

            // Sell logic: Close breaks below trailing low, close acceptance is negative, and efficiency is high
            if (currentClose < lo && acc < 0) {
                return createSellSignal(cleanData, i, `Compressed Boundary Breakout Bearish (close=${currentClose}, lo=${lo}, eff=${eff.toFixed(3)}, acc=${acc.toFixed(3)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEfficiency"],
    },
};
