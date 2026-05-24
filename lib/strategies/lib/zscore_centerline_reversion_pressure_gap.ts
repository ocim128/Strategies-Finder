import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeZscoreCenterlineReversionPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        threshold: normalizeNumberParam(params.threshold, 2.0, 0.1),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

export const zscore_centerline_reversion_pressure_gap: Strategy = {
    name: "Z-Score Centerline Reversion with Pressure Gap",
    description: "Fades rolling typical-price z-score extremes only when the Polymarket pressure gap underprices the reversion side.",
    defaultParams: {
        lookback: 30,
        threshold: 2.0,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Z-Score Threshold",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeZscoreCenterlineReversionPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeZscoreCenterlineReversionPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const zScore = buildRollingZScore(getTypicalPrices(cleanData), lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [zScore, pressure.longEdge, pressure.shortEdge], (i) => {
            const z = zScore[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (z === null || longEdge === null || shortEdge === null) return null;

            if (z <= -p.threshold && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "Typical-price downside z-score extreme with YES pressure edge");
            }
            if (z >= p.threshold && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "Typical-price upside z-score extreme with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold", "minEdge"],
    },
};
