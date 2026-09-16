import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildAdjacentRangeOverlapSeries,
    buildCloseLocationSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const adjacent_range_balance_bracket_fade: Strategy = {
    name: "Adjacent Range Balance Bracket Fade",
    description: "Fades boundary extremes when rolling mean range overlap indicates a balanced equilibrium bracket (>=0.60).",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const avgOverlap = buildRollingAverage(overlap, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [avgOverlap, closeLocation], (i) => {
            const avg = avgOverlap[i];
            const cl = closeLocation[i];
            if (avg === null || cl === null) return null;

            if (avg >= 0.60) {
                if (cl <= 0.15) {
                    return createBuySignal(cleanData, i, `Bullish balance bracket fade: avg overlap ${avg.toFixed(2)} >= 0.60, closeLocation ${cl.toFixed(2)} <= 0.15`);
                }
                if (cl >= 0.85) {
                    return createSellSignal(cleanData, i, `Bearish balance bracket fade: avg overlap ${avg.toFixed(2)} >= 0.60, closeLocation ${cl.toFixed(2)} >= 0.85`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
