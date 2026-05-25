import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateATR } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

type TailVolatilityDislocationExecutableEdgePrepared = {
    cleanData: OHLCVData[];
    highs: number[];
    lows: number[];
    closes: number[];
    typicals: number[];
    medianByLookback: Map<number, (number | null)[]>;
    atrByLookback: Map<number, (number | null)[]>;
};

function normalizeTailVolatilityDislocationExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        atrMultiplier: normalizeNumberParam(params.atrMultiplier, 2.2, 0.1),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

function prepareTailVolatilityDislocationExecutableEdgeData(data: OHLCVData[]): TailVolatilityDislocationExecutableEdgePrepared {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        highs: getHighs(cleanData),
        lows: getLows(cleanData),
        closes: getCloses(cleanData),
        typicals: getTypicalPrices(cleanData),
        medianByLookback: new Map(),
        atrByLookback: new Map(),
    };
}

function getPreparedTailVolatilityDislocationExecutableEdgeData(
    preparedData: unknown,
    data: OHLCVData[]
): TailVolatilityDislocationExecutableEdgePrepared {
    if (
        preparedData
        && typeof preparedData === "object"
        && "medianByLookback" in preparedData
        && "atrByLookback" in preparedData
    ) {
        return preparedData as TailVolatilityDislocationExecutableEdgePrepared;
    }
    return prepareTailVolatilityDislocationExecutableEdgeData(data);
}

function getPreparedMedian(
    prepared: TailVolatilityDislocationExecutableEdgePrepared,
    lookback: number
): (number | null)[] {
    let median = prepared.medianByLookback.get(lookback);
    if (!median) {
        median = buildRollingMedian(prepared.typicals, lookback);
        prepared.medianByLookback.set(lookback, median);
    }
    return median;
}

function getPreparedAtr(
    prepared: TailVolatilityDislocationExecutableEdgePrepared,
    lookback: number
): (number | null)[] {
    let atr = prepared.atrByLookback.get(lookback);
    if (!atr) {
        atr = calculateATR(prepared.highs, prepared.lows, prepared.closes, lookback);
        prepared.atrByLookback.set(lookback, atr);
    }
    return atr;
}

export const tail_volatility_dislocation_executable_edge: Strategy = {
    name: "Tail Volatility Dislocation with Executable Edge",
    description: "Trades ATR tail dislocations only when the matching Polymarket ask is actionable and underpriced.",
    defaultParams: {
        lookback: 30,
        atrMultiplier: 2.2,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        atrMultiplier: "ATR Multiplier",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeTailVolatilityDislocationExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data) => prepareTailVolatilityDislocationExecutableEdgeData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedTailVolatilityDislocationExecutableEdgeData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeTailVolatilityDislocationExecutableEdgeParams(params);
        const lookback = p.lookback;
        const slowLookback = lookback * 3;
        if (cleanData.length < slowLookback + 1) return [];

        const typicals = prepared.typicals;
        const median = getPreparedMedian(prepared, lookback);
        const fastAtr = getPreparedAtr(prepared, lookback);
        const slowAtr = getPreparedAtr(prepared, slowLookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [median, fastAtr, slowAtr], (i) => {
            const center = median[i];
            const fast = fastAtr[i];
            const slow = slowAtr[i];
            if (center === null || fast === null || slow === null || slow <= 0 || fast / slow < 1.5) return null;

            if (
                typicals[i] > center + p.atrMultiplier * fast
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Upper ATR tail dislocation with executable YES edge");
            }
            if (
                typicals[i] < center - p.atrMultiplier * fast
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Lower ATR tail dislocation with executable NO edge");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
        tail_volatility_dislocation_executable_edge.executePrepared?.(
            prepareTailVolatilityDislocationExecutableEdgeData(data),
            params,
            data,
            context
        ) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "atrMultiplier", "minEdge"],
    },
};
