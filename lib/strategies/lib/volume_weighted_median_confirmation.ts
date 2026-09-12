import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { calculateVolumeWeightedMedian } from "../trend-confirmation-indicators";

type VolumeWeightedMedianPrepared = {
    data: OHLCVData[];
    closes: number[];
    volumes: number[];
    medianByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 200))),
    };
}

function prepareData(data: OHLCVData[]): VolumeWeightedMedianPrepared {
    const cleanData = ensureCleanData(data);
    return {
        data: cleanData,
        closes: getCloses(cleanData),
        volumes: getVolumes(cleanData),
        medianByLookback: new Map<number, (number | null)[]>(),
    };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): VolumeWeightedMedianPrepared {
    if (preparedData && typeof preparedData === "object" && "medianByLookback" in preparedData) {
        return preparedData as VolumeWeightedMedianPrepared;
    }
    return prepareData(data);
}

export const volume_weighted_median_confirmation: Strategy = {
    name: "Volume-Weighted Median Confirmation",
    description: "Confirms direction relative to the trailing median price weighted by traded volume.",
    defaultParams: {
        lookback: 200,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const lookback = normalizeParams(params).lookback as number;
        let median = prepared.medianByLookback.get(lookback);
        if (!median) {
            median = calculateVolumeWeightedMedian(prepared.closes, prepared.volumes, lookback);
            prepared.medianByLookback.set(lookback, median);
        }

        return createCurrentBarSignalLoop(prepared.data, [median], (i) => {
            if (prepared.closes[i] > median[i]!) {
                return createBuySignal(prepared.data, i, "Close above volume-weighted median");
            }
            if (prepared.closes[i] < median[i]!) {
                return createSellSignal(prepared.data, i, "Close below volume-weighted median");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        volume_weighted_median_confirmation.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
