import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildBodyPctSeries, buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingSkewness, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        rangePercentileMin: Math.max(0.5, Math.min(0.99, Number(params.rangePercentileMin ?? 0.70))),
    };
}

export const body_imbalance_range_confirmation: Strategy = {
    name: "Body Imbalance Range Confirmation",
    description: "Trades directional body-percentage skewness during high-percentile range dislocations with close acceptance.",
    defaultParams: {
        lookback: 30,
        rangePercentileMin: 0.70,
    },
    paramLabels: {
        lookback: "Lookback",
        rangePercentileMin: "Min Range Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const bodyPct = buildBodyPctSeries(cleanData);
        const bodyPctSkew = buildRollingSkewness(bodyPct, lookback);
        const ranges = buildRangeSeries(cleanData);
        const rangePctl = buildPercentileRank(ranges, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [bodyPctSkew, rangePctl], (i) => {
            const skew = bodyPctSkew[i];
            const pctl = rangePctl[i];
            if (skew === null || pctl === null) return null;
            if (pctl < (p.rangePercentileMin as number)) return null;

            const cl = closeLocation[i];
            if (skew > 0 && cl > 0.5) {
                return createBuySignal(cleanData, i, `Body pct skew ${skew.toFixed(2)} range pctl ${pctl.toFixed(2)} bullish`);
            }
            if (skew < 0 && cl < 0.5) {
                return createSellSignal(cleanData, i, `Body pct skew ${skew.toFixed(2)} range pctl ${pctl.toFixed(2)} bearish`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePercentileMin"],
    },
};
