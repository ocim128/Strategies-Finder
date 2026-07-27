import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

type RollingMedianPrepared = {
    data: OHLCVData[];
    closes: number[];
    medianByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 200))),
    };
}

function prepareData(data: OHLCVData[]): RollingMedianPrepared {
    const cleanData = ensureCleanData(data);
    return {
        data: cleanData,
        closes: getCloses(cleanData),
        medianByLookback: new Map<number, (number | null)[]>(),
    };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): RollingMedianPrepared {
    if (preparedData && typeof preparedData === "object" && "medianByLookback" in preparedData) {
        return preparedData as RollingMedianPrepared;
    }
    return prepareData(data);
}

export const rolling_median_confirmation: Strategy = {
    name: "Rolling Median Confirmation",
    description: "Confirms direction relative to a trailing median that is resistant to isolated price spikes.",
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
            median = buildRollingMedian(prepared.closes, lookback);
            prepared.medianByLookback.set(lookback, median);
        }

        return createCurrentBarSignalLoop(prepared.data, [median], (i) => {
            if (prepared.closes[i] > median[i]!) {
                return createBuySignal(prepared.data, i, "Close above rolling median");
            }
            if (prepared.closes[i] < median[i]!) {
                return createSellSignal(prepared.data, i, "Close below rolling median");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        rolling_median_confirmation.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
