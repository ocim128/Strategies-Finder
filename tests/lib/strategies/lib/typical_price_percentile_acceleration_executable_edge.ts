import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

type TypicalPricePercentileAccelerationExecutableEdgePrepared = {
    cleanData: OHLCVData[];
    typicals: number[];
    percentileByLookback: Map<number, (number | null)[]>;
};

function hasRecentExtreme(
    percentile: (number | null)[],
    index: number,
    bars: number,
    predicate: (value: number) => boolean
): boolean {
    const start = Math.max(0, index - bars);
    for (let i = start; i < index; i++) {
        const value = percentile[i];
        if (value !== null && predicate(value)) return true;
    }
    return false;
}

function normalizeTypicalPricePercentileAccelerationExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        pctThreshold: normalizeNumberParam(params.pctThreshold, 0.35, 0.01, 0.99),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

function prepareTypicalPricePercentileAccelerationExecutableEdgeData(
    data: OHLCVData[]
): TypicalPricePercentileAccelerationExecutableEdgePrepared {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        typicals: getTypicalPrices(cleanData),
        percentileByLookback: new Map(),
    };
}

function getPreparedTypicalPricePercentileAccelerationExecutableEdgeData(
    preparedData: unknown,
    data: OHLCVData[]
): TypicalPricePercentileAccelerationExecutableEdgePrepared {
    if (
        preparedData
        && typeof preparedData === "object"
        && "percentileByLookback" in preparedData
    ) {
        return preparedData as TypicalPricePercentileAccelerationExecutableEdgePrepared;
    }
    return prepareTypicalPricePercentileAccelerationExecutableEdgeData(data);
}

function getPreparedPercentile(
    prepared: TypicalPricePercentileAccelerationExecutableEdgePrepared,
    lookback: number
): (number | null)[] {
    let percentile = prepared.percentileByLookback.get(lookback);
    if (!percentile) {
        percentile = buildPercentileRank(prepared.typicals, lookback);
        prepared.percentileByLookback.set(lookback, percentile);
    }
    return percentile;
}

export const typical_price_percentile_acceleration_executable_edge: Strategy = {
    name: "Typical Price Percentile Acceleration with Executable Edge",
    description: "Trades percentile acceleration out of typical-price extremes only when the matching Polymarket ask is actionable and underpriced.",
    defaultParams: {
        lookback: 30,
        pctThreshold: 0.35,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        pctThreshold: "Percentile Threshold",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeTypicalPricePercentileAccelerationExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data) => prepareTypicalPricePercentileAccelerationExecutableEdgeData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedTypicalPricePercentileAccelerationExecutableEdgeData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeTypicalPricePercentileAccelerationExecutableEdgeParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 4) return [];

        const percentile = getPreparedPercentile(prepared, lookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [percentile], (i) => {
            const rank = percentile[i];
            const previousRank = percentile[i - 1];
            if (rank === null || previousRank === null) return null;

            if (
                hasRecentExtreme(percentile, i, 3, (value) => value <= 0.2)
                && previousRank < p.pctThreshold
                && rank >= p.pctThreshold
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Typical-price percentile accelerated from low extreme with executable YES edge");
            }
            if (
                hasRecentExtreme(percentile, i, 3, (value) => value >= 0.8)
                && previousRank > 1 - p.pctThreshold
                && rank <= 1 - p.pctThreshold
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Typical-price percentile decelerated from high extreme with executable NO edge");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
        typical_price_percentile_acceleration_executable_edge.executePrepared?.(
            prepareTypicalPricePercentileAccelerationExecutableEdgeData(data),
            params,
            data,
            context
        ) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pctThreshold", "minEdge"],
    },
};
