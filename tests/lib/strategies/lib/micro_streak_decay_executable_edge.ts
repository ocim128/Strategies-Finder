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

function normalizeMicroStreakDecayExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakLength: normalizeIntegerParam(params.streakLength, 5, 2),
        volLookback: normalizeIntegerParam(params.volLookback, 30, 5),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
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
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeMicroStreakDecayExecutableEdgeParams(params);
        if (cleanData.length < p.volLookback + p.streakLength + 1) return [];

        const closes = getCloses(cleanData);
        const center = buildRollingAverage(getTypicalPrices(cleanData), p.volLookback);
        const flags = closes.map((close, i) => {
            const midpoint = center[i];
            if (midpoint === null) return 0;
            if (close > midpoint) return 1;
            if (close < midpoint) return -1;
            return 0;
        });
        const streak = buildStreakCount(flags);
        const closeLocation = buildCloseLocationSeries(cleanData);
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
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakLength", "volLookback", "minEdge"],
    },
};
