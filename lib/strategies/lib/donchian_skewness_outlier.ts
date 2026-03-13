import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateDonchianChannels } from "../indicators";
import { buildRollingSkewness } from "./price-action-statistics-core";

export const donchian_skewness_outlier: Strategy = {
    name: "Donchian Skewness Outlier",
    description: "Identifies false institutional breakouts by mapping structural channel breaches against deeply opposing return distribution skewness. Trades the mean-reversion when a new high/low occurs inside an incompatible statistical regime.",
    defaultParams: {
        donchPeriod: 20,
        skewLookback: 40,
        skewThreshold: 0.8,
    },
    paramLabels: {
        donchPeriod: "Donchian Period",
        skewLookback: "Skewness Window",
        skewThreshold: "Absolute Skew Threshold",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const dPeriod = params.donchPeriod as number;
        const sLookback = params.skewLookback as number;

        if (cleanData.length < Math.max(dPeriod, sLookback) + 10) return [];

        const donchian = calculateDonchianChannels(
            cleanData.map(d => d.high),
            cleanData.map(d => d.low),
            dPeriod
        );

        const returns = cleanData.map((d, i) => i === 0 ? 0 : (d.close - cleanData[i - 1].close) / (cleanData[i - 1].close || 1));
        const safeReturns = returns.map(v => v === 0 ? 0.000001 : v);
        const skewness = buildRollingSkewness(safeReturns, sLookback);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < Math.max(dPeriod, sLookback) || donchian.upper[i] === null || donchian.lower[i] === null || skewness[i] === null) return null;

            const currLow = cleanData[i].low;
            const currHigh = cleanData[i].high;
            const skew = skewness[i]!;
            const thresh = params.skewThreshold as number;

            // Buy: Tagged lower Donchian but distribution is heavily biased upward (skew > positive thresh)
            if (currLow <= donchian.lower[i]! && skew > thresh) {
                return createBuySignal(cleanData, i, "Mean-reversion off lower Donchian boundary in conflicting positive-skew regime");
            }

            // Sell: Tagged upper Donchian but distribution is heavily biased downward (skew < negative thresh)
            if (currHigh >= donchian.upper[i]! && skew < -thresh) {
                return createSellSignal(cleanData, i, "Mean-reversion off upper Donchian boundary in conflicting negative-skew regime");
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["donchPeriod", "skewLookback", "skewThreshold"],
    },
};
