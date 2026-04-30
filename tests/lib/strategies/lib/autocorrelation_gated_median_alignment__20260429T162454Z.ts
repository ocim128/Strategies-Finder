import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingAutoCorrelation, buildRollingMedian } from "./price-action-statistics-core";

function normalizeAutocorrelationGatedMedianAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        median_lookback: Math.max(2, Math.round(Number(params.median_lookback ?? 55))),
        corr_threshold: Number(params.corr_threshold ?? 0.5),
    };
}

export const autocorrelation_gated_median_alignment: Strategy = {
    name: "Autocorrelation Gated Median Alignment",
    description:
        "Uses positive autocorrelation of daily returns as a persistence gate and only aligns entries with a rolling median once serial dependence is strong enough.",
    defaultParams: {
        median_lookback: 55,
        corr_threshold: 0.5,
    },
    paramLabels: {
        median_lookback: "Median Lookback",
        corr_threshold: "Corr Threshold",
    },
    normalizeParams: normalizeAutocorrelationGatedMedianAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAutocorrelationGatedMedianAlignmentParams(params);
        const medianLookback = p.median_lookback as number;
        const threshold = p.corr_threshold as number;
        const autocorrLookback = 30;
        if (cleanData.length < Math.max(medianLookback, autocorrLookback) + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, medianLookback);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const autocorrelation = buildRollingAutoCorrelation(returns, autocorrLookback);

        return createSignalLoop(cleanData, [median, autocorrelation], (i) => {
            const m = median[i];
            const autocorr = autocorrelation[i];
            if (m === null || autocorr === null || autocorr <= threshold) return null;

            if (closes[i] > m) {
                return createBuySignal(cleanData, i, `Autocorrelation ${autocorr.toFixed(3)} with close above median`);
            }
            if (closes[i] < m) {
                return createSellSignal(cleanData, i, `Autocorrelation ${autocorr.toFixed(3)} with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["median_lookback", "corr_threshold"],
    },
};
