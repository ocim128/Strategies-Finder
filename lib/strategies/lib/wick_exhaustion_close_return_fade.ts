import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRangeSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        rangePercentileMin: Math.max(0.5, Math.min(0.99, Number(params.rangePercentileMin ?? 0.70))),
        wickImbalanceMin: Math.max(0.1, Math.min(0.9, Number(params.wickImbalanceMin ?? 0.30))),
    };
}

export const wick_exhaustion_close_return_fade: Strategy = {
    name: "Wick Exhaustion Close Return Fade",
    description: "Fades failed dislocations when extreme directional wicks are rejected with close return confirmation.",
    defaultParams: {
        lookback: 30,
        rangePercentileMin: 0.70,
        wickImbalanceMin: 0.30,
    },
    paramLabels: {
        lookback: "Lookback",
        rangePercentileMin: "Min Range Percentile",
        wickImbalanceMin: "Min Wick Imbalance",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const ranges = buildRangeSeries(cleanData);
        const rangePctl = buildPercentileRank(ranges, lookback);
        const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");

        return createSignalLoop(cleanData, [rangePctl], (i) => {
            const rp = rangePctl[i];
            if (rp === null) return null;
            if (rp < (p.rangePercentileMin as number)) return null;

            const wi = wickImbalance[i];
            const cr = closeReturn[i];
            const wiMin = p.wickImbalanceMin as number;

            // Buy: downside wick rejection (wi < -min) with close return up
            if (wi < -wiMin && cr > 0) {
                return createBuySignal(cleanData, i, `Wick exhaustion wi ${wi.toFixed(2)} close return ${cr.toFixed(4)} fade buy`);
            }
            // Sell: upside wick rejection (wi > min) with close return down
            if (wi > wiMin && cr < 0) {
                return createSellSignal(cleanData, i, `Wick exhaustion wi ${wi.toFixed(2)} close return ${cr.toFixed(4)} fade sell`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePercentileMin", "wickImbalanceMin"],
    },
};
