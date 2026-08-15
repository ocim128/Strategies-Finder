import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRollingMedian } from "./price-action-statistics-core";

const ATR_STRETCH_BAND = 2.0;

function normalizeMedianAtrStretchReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const median_atr_stretch_reversion: Strategy = {
    name: "Median ATR Stretch Reversion",
    description: "Fades closes stretched at least 2 ATR from their rolling median, normalizing the stretch by the pair's own volatility.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeMedianAtrStretchReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeMedianAtrStretchReversionParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const medians = buildRollingMedian(closes, lookback);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);

        return createSignalLoop(cleanData, [medians, atr], (i) => {
            if (i < lookback) return null;
            const median = medians[i];
            const atrNow = atr[i];
            if (median === null || atrNow === null || atrNow <= 0) return null;

            if ((median - closes[i]) / atrNow >= ATR_STRETCH_BAND) {
                return createBuySignal(cleanData, i, `Median ATR stretch buy: close ${((median - closes[i]) / atrNow).toFixed(2)} ATR below median`);
            }
            if ((closes[i] - median) / atrNow >= ATR_STRETCH_BAND) {
                return createSellSignal(cleanData, i, `Median ATR stretch sell: close ${((closes[i] - median) / atrNow).toFixed(2)} ATR above median`);
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
