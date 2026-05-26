import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

type MicroStreakDecayExecutableEdgePrepared = {
    cleanData: OHLCVData[];
    closes: number[];
    typicalPrices: number[];
    closeLocation: number[];
    centerByVolLookback: Map<number, ReturnType<typeof buildRollingAverage>>;
    streakByVolLookback: Map<number, ReturnType<typeof buildStreakCount>>;
};

function normalizeMicroStreakDecayExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakLength: normalizeIntegerParam(params.streakLength, 5, 2),
        volLookback: normalizeIntegerParam(params.volLookback, 30, 5),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

function prepareMicroStreakDecayExecutableEdgeData(data: OHLCVData[]): MicroStreakDecayExecutableEdgePrepared {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        closes: getCloses(cleanData),
        typicalPrices: getTypicalPrices(cleanData),
        closeLocation: buildCloseLocationSeries(cleanData),
        centerByVolLookback: new Map(),
        streakByVolLookback: new Map(),
    };
}

function getPreparedMicroStreakDecayExecutableEdgeData(
    preparedData: unknown,
    data: OHLCVData[]
): MicroStreakDecayExecutableEdgePrepared {
    if (
        preparedData
        && typeof preparedData === "object"
        && "cleanData" in preparedData
        && "centerByVolLookback" in preparedData
        && "streakByVolLookback" in preparedData
    ) {
        return preparedData as MicroStreakDecayExecutableEdgePrepared;
    }
    return prepareMicroStreakDecayExecutableEdgeData(data);
}

function getPreparedCenter(
    prepared: MicroStreakDecayExecutableEdgePrepared,
    volLookback: number
): ReturnType<typeof buildRollingAverage> {
    const cached = prepared.centerByVolLookback.get(volLookback);
    if (cached) return cached;
    const center = buildRollingAverage(prepared.typicalPrices, volLookback);
    prepared.centerByVolLookback.set(volLookback, center);
    return center;
}

function getPreparedStreak(
    prepared: MicroStreakDecayExecutableEdgePrepared,
    volLookback: number
): ReturnType<typeof buildStreakCount> {
    const cached = prepared.streakByVolLookback.get(volLookback);
    if (cached) return cached;
    const center = getPreparedCenter(prepared, volLookback);
    const flags: number[] = new Array(prepared.closes.length);
    for (let i = 0; i < prepared.closes.length; i++) {
        const midpoint = center[i];
        if (midpoint === null) {
            flags[i] = 0;
        } else if (prepared.closes[i] > midpoint) {
            flags[i] = 1;
        } else if (prepared.closes[i] < midpoint) {
            flags[i] = -1;
        } else {
            flags[i] = 0;
        }
    }
    const streak = buildStreakCount(flags);
    prepared.streakByVolLookback.set(volLookback, streak);
    return streak;
}

export const micro_streak_decay_executable_edge: Strategy = {
    name: "Micro Streak Decay with Executable Edge",
    description: "Fades decaying close-vs-center streaks only when the matching Polymarket ask has executable edge.",
    defaultParams: {
        streakLength: 5,
        volLookback: 30,
        minEdge: 0.02,
    },
    paramLabels: {
        streakLength: "Streak Length",
        volLookback: "Executable Edge Volatility Lookback",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeMicroStreakDecayExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data) => prepareMicroStreakDecayExecutableEdgeData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedMicroStreakDecayExecutableEdgeData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeMicroStreakDecayExecutableEdgeParams(params);
        if (cleanData.length < p.volLookback + p.streakLength + 1) return [];

        const center = getPreparedCenter(prepared, p.volLookback);
        const streak = getPreparedStreak(prepared, p.volLookback);
        const closeLocation = prepared.closeLocation;
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: p.volLookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: p.volLookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [], (i) => {
            if (i < p.volLookback + p.streakLength || center[i] === null) return null;

            if (
                streak[i - 1] <= -p.streakLength
                && closeLocation[i] >= 0.7
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Bearish micro streak decayed with executable YES edge");
            }
            if (
                streak[i - 1] >= p.streakLength
                && closeLocation[i] <= 0.3
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Bullish micro streak decayed with executable NO edge");
            }
            return null;
        });
    },
    execute: (data, params, context) => {
        if (!context?.polymarket1s) return [];
        return micro_streak_decay_executable_edge.executePrepared?.(
            prepareMicroStreakDecayExecutableEdgeData(data),
            params,
            data,
            context
        ) ?? [];
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakLength", "volLookback", "minEdge"],
    },
};
