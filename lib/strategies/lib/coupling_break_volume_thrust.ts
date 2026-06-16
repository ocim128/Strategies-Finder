import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        rangeThreshold: Math.max(0, Math.min(1, Number(params.rangeThreshold ?? 0.80))),
        volThreshold: Math.max(0, Math.min(1, Number(params.volThreshold ?? 0.75))),
    };
}

export const coupling_break_volume_thrust: Strategy = {
    name: "Coupling Break Volume Thrust",
    description: "Chases breakouts from compressed ranges confirmed by volume spikes.",
    defaultParams: {
        lookback: 30,
        rangeThreshold: 0.80,
        volThreshold: 0.75,
    },
    paramLabels: {
        lookback: "Lookback Window",
        rangeThreshold: "Range Percentile Threshold",
        volThreshold: "Volume Percentile Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const ranges = buildRangeSeries(cleanData);
        const rangePercentile = buildPercentileRank(ranges, lookback);

        const volumes = getVolumes(cleanData);
        const volPercentile = buildPercentileRank(volumes, lookback);

        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [rangePercentile, volPercentile], (i) => {
            const rp = rangePercentile[i];
            const vp = volPercentile[i];
            if (rp === null || vp === null) return null;

            // Check if range was compressed (< 0.40) within prior 4 bars
            let hasCompression = false;
            for (let k = 1; k <= 4; k++) {
                const prevIdx = i - k;
                if (prevIdx >= 0) {
                    const prevRp = rangePercentile[prevIdx];
                    if (prevRp !== null && prevRp < 0.40) {
                        hasCompression = true;
                        break;
                    }
                }
            }

            if (!hasCompression) return null;

            const cl = closeLocation[i];

            if (rp > p.rangeThreshold && vp > p.volThreshold) {
                if (cl > 0.7) {
                    return createBuySignal(cleanData, i, `Coupling break buy: range rank ${rp.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
                if (cl < 0.3) {
                    return createSellSignal(cleanData, i, `Coupling break sell: range rank ${rp.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangeThreshold", "volThreshold"],
    },
};
