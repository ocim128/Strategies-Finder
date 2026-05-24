import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingMinMax, buildRollingSkewness } from "./price-action-statistics-core";
import { buildPolymarket1sNoAdverseActionableMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeVolumeSkewnessAccelerationNoAdverseParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 40, 5),
        skewThreshold: normalizeNumberParam(params.skewThreshold, 1.4, 0),
    };
}

export const volume_skewness_acceleration_no_adverse: Strategy = {
    name: "Volume Skewness Acceleration with No Adverse Mask",
    description: "Fades trailing price boundaries when volume-return skewness spikes and Polymarket no-adverse actionability allows the side.",
    defaultParams: {
        lookback: 40,
        skewThreshold: 1.4,
    },
    paramLabels: {
        lookback: "Lookback",
        skewThreshold: "Volume Skewness Threshold",
    },
    normalizeParams: normalizeVolumeSkewnessAccelerationNoAdverseParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeSkewnessAccelerationNoAdverseParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const volumes = getVolumes(cleanData);
        const volumeReturns = volumes.map((volume, i) => i === 0 || volumes[i - 1] <= 0 ? 0 : Math.log(Math.max(volume, 1e-12) / volumes[i - 1]));
        const skewness = buildRollingSkewness(volumeReturns, lookback);
        const boundary = buildRollingMinMax(typicals, lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [skewness, boundary.min, boundary.max], (i) => {
            const skew = skewness[i];
            const low = boundary.min[i];
            const high = boundary.max[i];
            if (skew === null || low === null || high === null || skew < p.skewThreshold) return null;

            if (typicals[i] <= low && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Volume-return skewness at trailing low with no adverse YES mask");
            }
            if (typicals[i] >= high && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Volume-return skewness at trailing high with no adverse NO mask");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold"],
    },
};
