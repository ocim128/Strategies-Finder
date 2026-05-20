import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 25))),
        skewThreshold: Math.max(0.01, Number(params.skewThreshold ?? 0.20)),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    };
}

export const close_location_skew_reversion_pressure_gap: Strategy = {
    name: "Close Location Skew Reversion Pressure Gap",
    description: "Fades extreme directional distribution skews in Binance bar close locations, entering mean-rejection trades only when a favorable Polymarket pressure gap mismatch is active.",
    defaultParams: {
        lookback: 25,
        skewThreshold: 0.20,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Skew Lookback",
        skewThreshold: "Skewness Threshold",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const skewThreshold = p.skewThreshold as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback) return [];

        const closeLocs = buildCloseLocationSeries(cleanData);
        const average = buildRollingAverage(closeLocs, lookback);
        const median = buildRollingMedian(closeLocs, lookback);

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });

        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [average, median, pressure.longEdge, pressure.shortEdge], (i) => {
            if (i < 1) return null;

            const prevAvg = average[i - 1];
            const prevMedian = median[i - 1];
            const currentMedian = median[i];
            const currentCloseLoc = closeLocs[i];
            const prevCloseLoc = closeLocs[i - 1];

            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];

            if (
                prevAvg === null || prevMedian === null ||
                currentMedian === null ||
                longEdge === null || shortEdge === null
            ) return null;

            const prevDiff = prevAvg - prevMedian;

            // Buy: average minus rolling median is less than -skewThreshold (negative skew), crosses back above median
            if (prevDiff < -skewThreshold && prevCloseLoc < prevMedian && currentCloseLoc >= currentMedian && longEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Negative close location skew ${prevDiff.toFixed(2)} reverted above median with YES edge`);
            }

            // Sell: average minus rolling median is greater than skewThreshold (positive skew), crosses back below median
            if (prevDiff > skewThreshold && prevCloseLoc > prevMedian && currentCloseLoc <= currentMedian && shortEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Positive close location skew ${prevDiff.toFixed(2)} reverted below median with NO edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold", "minEdge"],
    },
};
