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

type RollingMinMaxFrame = ReturnType<typeof buildRollingMinMax>;

type VolumeSkewnessAccelerationNoAdversePrepared = {
    cleanData: OHLCVData[];
    typicals: number[];
    volumeReturns: number[];
    skewnessByLookback: Map<number, (number | null)[]>;
    boundaryByLookback: Map<number, RollingMinMaxFrame>;
};

function normalizeVolumeSkewnessAccelerationNoAdverseParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 40, 5),
        skewThreshold: normalizeNumberParam(params.skewThreshold, 1.4, 0),
    };
}

function buildVolumeReturnSeries(volumes: number[]): number[] {
    const result = new Array<number>(volumes.length).fill(0);
    for (let i = 1; i < volumes.length; i++) {
        const previous = volumes[i - 1];
        if (previous > 0) {
            result[i] = Math.log(Math.max(volumes[i], 1e-12) / previous);
        }
    }
    return result;
}

function prepareVolumeSkewnessAccelerationNoAdverseData(data: OHLCVData[]): VolumeSkewnessAccelerationNoAdversePrepared {
    const cleanData = ensureCleanData(data);
    const volumes = getVolumes(cleanData);
    return {
        cleanData,
        typicals: getTypicalPrices(cleanData),
        volumeReturns: buildVolumeReturnSeries(volumes),
        skewnessByLookback: new Map<number, (number | null)[]>(),
        boundaryByLookback: new Map<number, RollingMinMaxFrame>(),
    };
}

function getPreparedVolumeSkewnessAccelerationNoAdverseData(
    preparedData: unknown,
    data: OHLCVData[]
): VolumeSkewnessAccelerationNoAdversePrepared {
    if (
        preparedData
        && typeof preparedData === "object"
        && "skewnessByLookback" in preparedData
        && "boundaryByLookback" in preparedData
    ) {
        return preparedData as VolumeSkewnessAccelerationNoAdversePrepared;
    }
    return prepareVolumeSkewnessAccelerationNoAdverseData(data);
}

function getPreparedSkewness(
    prepared: VolumeSkewnessAccelerationNoAdversePrepared,
    lookback: number
): (number | null)[] {
    let skewness = prepared.skewnessByLookback.get(lookback);
    if (!skewness) {
        skewness = buildRollingSkewness(prepared.volumeReturns, lookback);
        prepared.skewnessByLookback.set(lookback, skewness);
    }
    return skewness;
}

function getPreparedBoundary(
    prepared: VolumeSkewnessAccelerationNoAdversePrepared,
    lookback: number
): RollingMinMaxFrame {
    let boundary = prepared.boundaryByLookback.get(lookback);
    if (!boundary) {
        boundary = buildRollingMinMax(prepared.typicals, lookback);
        prepared.boundaryByLookback.set(lookback, boundary);
    }
    return boundary;
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
    prepareFinderData: (data) => prepareVolumeSkewnessAccelerationNoAdverseData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedVolumeSkewnessAccelerationNoAdverseData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeVolumeSkewnessAccelerationNoAdverseParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const skewness = getPreparedSkewness(prepared, lookback);
        const boundary = getPreparedBoundary(prepared, lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [skewness, boundary.min, boundary.max], (i) => {
            const skew = skewness[i];
            const low = boundary.min[i];
            const high = boundary.max[i];
            if (skew === null || low === null || high === null || skew < p.skewThreshold) return null;

            if (prepared.typicals[i] <= low && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Volume-return skewness at trailing low with no adverse YES mask");
            }
            if (prepared.typicals[i] >= high && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Volume-return skewness at trailing high with no adverse NO mask");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];
        return volume_skewness_acceleration_no_adverse.executePrepared?.(
            prepareVolumeSkewnessAccelerationNoAdverseData(data),
            params,
            data,
            context
        ) ?? [];
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold"],
    },
};
