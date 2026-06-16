import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRollingAutoCorrelation,
    buildRollingZScore,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
        acThreshold: Math.max(-1, Math.min(1, Number(params.acThreshold ?? -0.15))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.8)),
    };
}

export const negative_autocorrelation_median_reversion: Strategy = {
    name: "Negative Autocorrelation Median Reversion",
    description: "Fades close price z-score deviations when negative rolling returns autocorrelation confirms a reverting regime.",
    defaultParams: {
        lookback: 35,
        acThreshold: -0.15,
        zThreshold: 1.8,
    },
    paramLabels: {
        lookback: "Lookback Window",
        acThreshold: "Max Autocorrelation",
        zThreshold: "Close Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const autoCorr = buildRollingAutoCorrelation(returns, lookback, 1);
        const closeZ = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [autoCorr, closeZ], (i) => {
            const ac = autoCorr[i];
            const z = closeZ[i];
            if (ac === null || z === null) return null;

            if (ac < p.acThreshold) {
                // Buy: negative autocorrelation and close is low -> long reversion
                if (z < -p.zThreshold) {
                    return createBuySignal(cleanData, i, `Negative autocorrelation reversion buy: Z ${z.toFixed(2)}, AC ${ac.toFixed(2)}`);
                }
                // Sell: negative autocorrelation and close is high -> short reversion
                if (z > p.zThreshold) {
                    return createSellSignal(cleanData, i, `Negative autocorrelation reversion sell: Z ${z.toFixed(2)}, AC ${ac.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "acThreshold", "zThreshold"],
    },
};
