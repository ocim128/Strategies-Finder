import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingMinMax, buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sGammaConsensusMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

type RollingMinMaxFrame = ReturnType<typeof buildRollingMinMax>;

type PriceVolumeCorrelationBreakGammaPrepared = {
    cleanData: OHLCVData[];
    closes: number[];
    typicals: number[];
    volumes: number[];
    closeLocation: number[];
    volumeZByLookback: Map<number, (number | null)[]>;
    clvAverageByLookback: Map<number, (number | null)[]>;
    closeRocByLookback: Map<number, (number | null)[]>;
    boundaryByLookback: Map<number, RollingMinMaxFrame>;
};

function normalizePriceVolumeCorrelationBreakGammaParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        volZThreshold: normalizeNumberParam(params.volZThreshold, 1.8, 0),
    };
}

function preparePriceVolumeCorrelationBreakGammaData(data: OHLCVData[]): PriceVolumeCorrelationBreakGammaPrepared {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        closes: getCloses(cleanData),
        typicals: getTypicalPrices(cleanData),
        volumes: getVolumes(cleanData),
        closeLocation: buildCloseLocationSeries(cleanData),
        volumeZByLookback: new Map<number, (number | null)[]>(),
        clvAverageByLookback: new Map<number, (number | null)[]>(),
        closeRocByLookback: new Map<number, (number | null)[]>(),
        boundaryByLookback: new Map<number, RollingMinMaxFrame>(),
    };
}

function getPreparedPriceVolumeCorrelationBreakGammaData(
    preparedData: unknown,
    data: OHLCVData[]
): PriceVolumeCorrelationBreakGammaPrepared {
    if (
        preparedData
        && typeof preparedData === "object"
        && "closeLocation" in preparedData
        && "volumeZByLookback" in preparedData
        && "boundaryByLookback" in preparedData
    ) {
        return preparedData as PriceVolumeCorrelationBreakGammaPrepared;
    }
    return preparePriceVolumeCorrelationBreakGammaData(data);
}

function getPreparedVolumeZ(
    prepared: PriceVolumeCorrelationBreakGammaPrepared,
    lookback: number
): (number | null)[] {
    let volumeZ = prepared.volumeZByLookback.get(lookback);
    if (!volumeZ) {
        volumeZ = buildRollingZScore(prepared.volumes, lookback);
        prepared.volumeZByLookback.set(lookback, volumeZ);
    }
    return volumeZ;
}

function getPreparedClvAverage(
    prepared: PriceVolumeCorrelationBreakGammaPrepared,
    lookback: number
): (number | null)[] {
    let clvAverage = prepared.clvAverageByLookback.get(lookback);
    if (!clvAverage) {
        clvAverage = buildRollingAverage(prepared.closeLocation, lookback);
        prepared.clvAverageByLookback.set(lookback, clvAverage);
    }
    return clvAverage;
}

function getPreparedCloseRoc(
    prepared: PriceVolumeCorrelationBreakGammaPrepared,
    lookback: number
): (number | null)[] {
    let closeRoc = prepared.closeRocByLookback.get(lookback);
    if (!closeRoc) {
        closeRoc = buildRateOfChange(prepared.closes, lookback);
        prepared.closeRocByLookback.set(lookback, closeRoc);
    }
    return closeRoc;
}

function getPreparedBoundary(
    prepared: PriceVolumeCorrelationBreakGammaPrepared,
    lookback: number
): RollingMinMaxFrame {
    let boundary = prepared.boundaryByLookback.get(lookback);
    if (!boundary) {
        boundary = buildRollingMinMax(prepared.typicals, lookback);
        prepared.boundaryByLookback.set(lookback, boundary);
    }
    return boundary;
}

export const price_volume_correlation_break_gamma: Strategy = {
    name: "Price-Volume Correlation Break with Gamma Consensus",
    description: "Fades high-volume flat-price absorption near trailing boundaries when Polymarket Gamma consensus agrees.",
    defaultParams: {
        lookback: 25,
        volZThreshold: 1.8,
    },
    paramLabels: {
        lookback: "Lookback",
        volZThreshold: "Volume Z-Score Threshold",
    },
    normalizeParams: normalizePriceVolumeCorrelationBreakGammaParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data) => preparePriceVolumeCorrelationBreakGammaData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedPriceVolumeCorrelationBreakGammaData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizePriceVolumeCorrelationBreakGammaParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const volumeZ = getPreparedVolumeZ(prepared, lookback);
        const clvAverage = getPreparedClvAverage(prepared, lookback);
        const closeRoc = getPreparedCloseRoc(prepared, lookback);
        const boundary = getPreparedBoundary(prepared, lookback);
        const mask = buildPolymarket1sGammaConsensusMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [volumeZ, clvAverage, closeRoc, boundary.min, boundary.max], (i) => {
            const volScore = volumeZ[i];
            const clv = clvAverage[i];
            const roc = closeRoc[i];
            const low = boundary.min[i];
            const high = boundary.max[i];
            if (volScore === null || clv === null || roc === null || low === null || high === null) return null;
            if (volScore < p.volZThreshold || Math.abs(roc) > 0.001) return null;

            const width = Math.max(1e-12, high - low);
            if (prepared.typicals[i] <= low + width * 0.1 && clv >= 0.7 && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "High-volume flat-price absorption near low with Gamma consensus");
            }
            if (prepared.typicals[i] >= high - width * 0.1 && clv <= 0.3 && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "High-volume flat-price absorption near high with Gamma consensus");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];
        return price_volume_correlation_break_gamma.executePrepared?.(
            preparePriceVolumeCorrelationBreakGammaData(data),
            params,
            data,
            context
        ) ?? [];
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volZThreshold"],
    },
};
