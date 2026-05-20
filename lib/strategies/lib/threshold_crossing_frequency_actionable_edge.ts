import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildThresholdCrossingCount } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        maxCrossings: Math.max(1, Math.round(Number(params.maxCrossings ?? 3))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    };
}

export const threshold_crossing_frequency_actionable_edge: Strategy = {
    name: "Threshold Crossing Frequency Actionable Edge",
    description: "Identifies decisive breakout regimes on Binance by measuring the frequency of rolling median crossings, using a same-side executable edge on Polymarket to secure high-probability execution.",
    defaultParams: {
        lookback: 30,
        maxCrossings: 3,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Crossing Lookback",
        maxCrossings: "Maximum Crossings",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const maxCrossings = p.maxCrossings as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);

        // Normalize difference between close and median to feed to buildThresholdCrossingCount
        const diffs = closes.map((c, i) => {
            const med = median[i];
            return med === null ? 0 : c - med;
        });

        // Calculate crossing events of 0.0 threshold
        const crossings = buildThresholdCrossingCount(diffs, lookback, 0.0);

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(cleanData, [median, crossings, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            const currentClose = closes[i];
            const currentMedian = median[i];
            const crossingCount = crossings[i];

            const buyYesEdge = edge.buyYesEdge[i];
            const buyNoEdge = edge.buyNoEdge[i];

            if (currentMedian === null || crossingCount === null || buyYesEdge === null || buyNoEdge === null) return null;

            // Buy: crossing count <= maxCrossings, close > rolling median, yesActionable is true, same-side edge positive
            if (crossingCount <= maxCrossings && currentClose > currentMedian && actionability.yesActionable[i] && buyYesEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Decisive low-chop breakout up (crossings=${crossingCount}) with YES edge ${buyYesEdge.toFixed(3)}`);
            }

            // Sell: crossing count <= maxCrossings, close < rolling median, noActionable is true, same-side edge positive
            if (crossingCount <= maxCrossings && currentClose < currentMedian && actionability.noActionable[i] && buyNoEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Decisive low-chop breakout down (crossings=${crossingCount}) with NO edge ${buyNoEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxCrossings", "minEdge"],
    },
};
