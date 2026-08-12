import type { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
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

const LAG_BARS = 10;
const ANCHOR_DISTANCE_ATR = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

type LaggedValuePrepared = {
    data: OHLCVData[];
    closes: number[];
    highs: number[];
    lows: number[];
    medianByLookback: Map<number, (number | null)[]>;
    atrByLookback: Map<number, (number | null)[]>;
};

function prepareData(data: OHLCVData[]): LaggedValuePrepared {
    const cleanData = ensureCleanData(data);
    return {
        data: cleanData,
        closes: getCloses(cleanData),
        highs: getHighs(cleanData),
        lows: getLows(cleanData),
        medianByLookback: new Map<number, (number | null)[]>(),
        atrByLookback: new Map<number, (number | null)[]>(),
    };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): LaggedValuePrepared {
    if (preparedData && typeof preparedData === "object" && "medianByLookback" in preparedData) {
        return preparedData as LaggedValuePrepared;
    }
    return prepareData(data);
}

export const lagged_value_anchor_reversion: Strategy = {
    name: "Lagged Value Anchor Reversion",
    description: "Fades closes stretched at least 2 ATR from where the rolling median sat 10 bars ago.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const lookback = normalizeParams(params).lookback as number;
        if (prepared.data.length < lookback + LAG_BARS) return [];

        let median = prepared.medianByLookback.get(lookback);
        if (!median) {
            median = buildRollingMedian(prepared.closes, lookback);
            prepared.medianByLookback.set(lookback, median);
        }
        let atr = prepared.atrByLookback.get(lookback);
        if (!atr) {
            atr = calculateATR(prepared.highs, prepared.lows, prepared.closes, lookback);
            prepared.atrByLookback.set(lookback, atr);
        }

        return createSignalLoop(prepared.data, [atr], (i) => {
            // The lagged anchor needs lookback warm-up bars plus the fixed lag.
            if (i < lookback + LAG_BARS) return null;
            const atrNow = atr[i];
            const anchor = median![i - LAG_BARS];
            if (atrNow === null || atrNow <= 0 || anchor === null) return null;

            const stretchDown = (anchor - prepared.closes[i]) / atrNow;
            if (stretchDown >= ANCHOR_DISTANCE_ATR) {
                return createBuySignal(prepared.data, i, `Lagged anchor buy: close ${stretchDown.toFixed(2)} ATR below ${LAG_BARS}-bar-old median`);
            }
            const stretchUp = (prepared.closes[i] - anchor) / atrNow;
            if (stretchUp >= ANCHOR_DISTANCE_ATR) {
                return createSellSignal(prepared.data, i, `Lagged anchor sell: close ${stretchUp.toFixed(2)} ATR above ${LAG_BARS}-bar-old median`);
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        lagged_value_anchor_reversion.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
