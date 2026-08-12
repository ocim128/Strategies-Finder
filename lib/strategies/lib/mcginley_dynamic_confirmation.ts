import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateMcGinleyDynamic } from "../trend-confirmation-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 200))),
    };
}

type McGinleyPrepared = {
    data: OHLCVData[];
    closes: number[];
    dynamicByLookback: Map<number, (number | null)[]>;
};

function prepareData(data: OHLCVData[]): McGinleyPrepared {
    const cleanData = ensureCleanData(data);
    return {
        data: cleanData,
        closes: getCloses(cleanData),
        dynamicByLookback: new Map<number, (number | null)[]>(),
    };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): McGinleyPrepared {
    if (preparedData && typeof preparedData === "object" && "dynamicByLookback" in preparedData) {
        return preparedData as McGinleyPrepared;
    }
    return prepareData(data);
}

export const mcginley_dynamic_confirmation: Strategy = {
    name: "McGinley Dynamic Confirmation",
    description: "Confirms direction relative to a dynamic average that adjusts its response to price movement.",
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
        let dynamic = prepared.dynamicByLookback.get(lookback);
        if (!dynamic) {
            dynamic = calculateMcGinleyDynamic(prepared.closes, lookback);
            prepared.dynamicByLookback.set(lookback, dynamic);
        }

        return createCurrentBarSignalLoop(prepared.data, [dynamic], (i) => {
            if (prepared.closes[i] > dynamic[i]!) return createBuySignal(prepared.data, i, "Close above McGinley Dynamic");
            if (prepared.closes[i] < dynamic[i]!) return createSellSignal(prepared.data, i, "Close below McGinley Dynamic");
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        mcginley_dynamic_confirmation.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
