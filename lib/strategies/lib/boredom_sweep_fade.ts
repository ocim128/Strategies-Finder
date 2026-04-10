import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildSweepReclaimSeries } from "./price-action-frequency-core";
import { buildRollingEntropy } from "./price-action-statistics-core";

function normalizeBoredomSweepFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        entropy_lookback: Math.max(2, Math.round(params.entropy_lookback ?? 30)),
        entropy_extreme: Math.max(0, Number(params.entropy_extreme ?? 0.8)),
        sweep_lookback: Math.max(2, Math.round(params.sweep_lookback ?? 10))
    };
}

export const boredom_sweep_fade: Strategy = {
    name: "Boredom Sweep Fade",
    description: "When market entropy maximizes (pure noise), participants stop trading. The first aggressive move out of this noise is frequently a stop-sweep before the true reversal.",
    defaultParams: {
        entropy_lookback: 30,
        entropy_extreme: 0.8,
        sweep_lookback: 10
    },
    paramLabels: {
        entropy_lookback: "Entropy Lookback",
        entropy_extreme: "Entropy Extreme Threshold",
        sweep_lookback: "Sweep Lookback"
    },
    normalizeParams: normalizeBoredomSweepFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBoredomSweepFadeParams(params);
        const lookback = Math.max(p.entropy_lookback as number, p.sweep_lookback as number);
        if (cleanData.length < lookback * 2) return [];

        const returns = cleanData.map((d, i) => i > 0 ? (d.close - cleanData[i - 1].close) / cleanData[i - 1].close : 0);
        const mappedReturns = returns.map(r => r === 0 ? 0.0000001 * (Math.random() - 0.5) : r);
        const entropy = buildRollingEntropy(mappedReturns, p.entropy_lookback as number);
        const sweepReclaim = buildSweepReclaimSeries(cleanData, p.sweep_lookback as number);

        return createSignalLoop(cleanData, [entropy, sweepReclaim], (i) => {
            if (i < lookback + 1) return null;
            
            const trailingEntropy = entropy[i - 1];
            if (trailingEntropy === null) return null;

            const sweepScore = sweepReclaim[i];
            if (sweepScore === null) return null;

            const extreme = p.entropy_extreme as number;

            if (trailingEntropy > extreme && sweepScore > 0) {
                return createBuySignal(cleanData, i, `Bullish sweep after trailing entropy > ${extreme}`);
            }
            if (trailingEntropy > extreme && sweepScore < 0) {
                return createSellSignal(cleanData, i, `Bearish sweep after trailing entropy > ${extreme}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["entropy_lookback", "entropy_extreme", "sweep_lookback"]
    }
};
