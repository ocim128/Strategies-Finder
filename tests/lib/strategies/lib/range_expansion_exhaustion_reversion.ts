import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        rangeThreshold: Math.max(0, Math.min(1, Number(params.rangeThreshold ?? 0.90))),
        maxVolumePercentile: Math.max(0, Math.min(1, Number(params.maxVolumePercentile ?? 0.40))),
    };
}

export const range_expansion_exhaustion_reversion: Strategy = {
    name: "Range Expansion Exhaustion Reversion",
    description: "Fades massive range expansions that lack volume support on the illiquid leg.",
    defaultParams: {
        lookback: 30,
        rangeThreshold: 0.90,
        maxVolumePercentile: 0.40,
    },
    paramLabels: {
        lookback: "Lookback Window",
        rangeThreshold: "Range Percentile Threshold",
        maxVolumePercentile: "Max Volume Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const ranges = buildRangeSeries(cleanData);
        const rangePctl = buildPercentileRank(ranges, lookback);

        const volumes = getVolumes(cleanData);
        const volPctl = buildPercentileRank(volumes, lookback);

        const returns = extractBarMetricSeries(cleanData, "closeReturn");

        return createSignalLoop(cleanData, [rangePctl, volPctl], (i) => {
            const rp = rangePctl[i];
            const vp = volPctl[i];
            if (rp === null || vp === null) return null;

            const ret = returns[i];

            if (rp > p.rangeThreshold && vp < p.maxVolumePercentile) {
                // Buy: massive range expansion on low volume with negative close return -> fade buy
                if (ret < 0) {
                    return createBuySignal(cleanData, i, `Range expansion exhaustion buy: range rank ${rp.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
                // Sell: massive range expansion on low volume with positive close return -> fade sell
                if (ret > 0) {
                    return createSellSignal(cleanData, i, `Range expansion exhaustion sell: range rank ${rp.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangeThreshold", "maxVolumePercentile"],
    },
};
