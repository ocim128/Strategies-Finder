import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(params.lookback ?? 20)) };
}

type PreparedData = {
    cleanData: OHLCVData[];
    trailingHighLow: { highest: (number | null)[]; lowest: (number | null)[] };
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        trailingHighLow: { highest: [], lowest: [] } };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const donchian_breakout_classic: Strategy = {
    name: "Donchian Breakout Classic",
    description: "Price breaking above its own N-bar highest high (or below its lowest low) is the original turtle-trading signal.",
    defaultParams: {
        lookback: 20 },
    paramLabels: {
        lookback: "Lookback" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const lookback = Math.max(3, Math.round(params.lookback ?? 20));

        if (cleanData.length < lookback + 2) return [];

        // Calculate trailing high/low, excluding current bar
        let trailingHighLow = prepared.trailingHighLow;
        if (trailingHighLow.highest.length === 0) {
            trailingHighLow = buildTrailingHighLow(cleanData, lookback, false);
            prepared.trailingHighLow = trailingHighLow;
        }

        const { highest, lowest } = trailingHighLow;
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + 1) return null;

            const hi = highest[i];
            const lo = lowest[i];
            const close = closes[i];

            if (hi === null || lo === null || close === null) return null;

            // Buy: Close exceeds trailing highest high
            if (close > hi) {
                return createBuySignal(cleanData, i, "Donchian Breakout Long");
            }

            // Sell: Close breaks below trailing lowest low
            if (close < lo) {
                return createSellSignal(cleanData, i, "Donchian Breakout Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        donchian_breakout_classic.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"] } };
