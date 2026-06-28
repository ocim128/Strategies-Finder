import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRangeSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        autocorrMin: Math.max(0.05, Math.min(0.95, Number(params.autocorrMin ?? 0.25))),
        rangePercentileMin: Math.max(0.5, Math.min(0.99, Number(params.rangePercentileMin ?? 0.70))),
    };
}

export const wick_imbalance_autocorrelation_expansion: Strategy = {
    name: "Wick Imbalance Autocorrelation Expansion",
    description: "Follows persistent directional rejection when wick imbalance autocorrelates during high-percentile range expansions.",
    defaultParams: {
        lookback: 30,
        autocorrMin: 0.25,
        rangePercentileMin: 0.70,
    },
    paramLabels: {
        lookback: "Lookback",
        autocorrMin: "Min Autocorrelation",
        rangePercentileMin: "Min Range Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 3) return [];

        const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        const wickAutocorr = buildRollingAutoCorrelation(wickImbalance, lookback);
        const ranges = buildRangeSeries(cleanData);
        const rangePctl = buildPercentileRank(ranges, lookback);
        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");

        return createSignalLoop(cleanData, [wickAutocorr, rangePctl], (i) => {
            const wa = wickAutocorr[i];
            const rp = rangePctl[i];
            if (wa === null || rp === null) return null;
            if (wa < (p.autocorrMin as number)) return null;
            if (rp < (p.rangePercentileMin as number)) return null;

            const cr = closeReturn[i];
            if (cr > 0) {
                return createBuySignal(cleanData, i, `Wick autocorr ${wa.toFixed(2)} range pctl ${rp.toFixed(2)} bullish`);
            }
            if (cr < 0) {
                return createSellSignal(cleanData, i, `Wick autocorr ${wa.toFixed(2)} range pctl ${rp.toFixed(2)} bearish`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "autocorrMin", "rangePercentileMin"],
    },
};
