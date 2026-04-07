import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateMomentum, calculateATR } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawAtrMultiplier = Number(params.atrMultiplier ?? 2.0);

    return {
        ...params,
        momentumPeriod: Math.max(2, Math.round(params.momentumPeriod ?? 10)),
        atrMultiplier: Math.max(0.5, Math.min(5.0, Number.isFinite(rawAtrMultiplier) ? rawAtrMultiplier : 2.0)) };
}

type PreparedData = {
    cleanData: OHLCVData[];
    momentum: (number | null)[];
    atr: (number | null)[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        momentum: [],
        atr: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const momentum_threshold_break: Strategy = {
    name: "Momentum Threshold Break",
    description: "calculateMomentum measures close[i] - close[i-N], the raw price change over N bars. When this exceeds a threshold normalized by ATR, the move is significant.",
    defaultParams: {
        momentumPeriod: 10,
        atrMultiplier: 2.0 },
    paramLabels: {
        momentumPeriod: "Momentum Period",
        atrMultiplier: "ATR Multiplier" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const momentumPeriod = Math.max(2, Math.round(params.momentumPeriod ?? 10));
        const atrMultiplier = Number(params.atrMultiplier ?? 2.0);

        if (cleanData.length < momentumPeriod + 20) return [];

        // Calculate Momentum
        let momentum = prepared.momentum;
        if (momentum.length === 0) {
            const closes = getCloses(cleanData);
            momentum = calculateMomentum(closes, momentumPeriod);
            prepared.momentum = momentum;
        }

        // Calculate ATR
        let atr = prepared.atr;
        if (atr.length === 0) {
            const highs = getHighs(cleanData);
            const lows = getLows(cleanData);
            const closes = getCloses(cleanData);
            atr = calculateATR(highs, lows, closes, 14);
            prepared.atr = atr;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < momentumPeriod + 1) return null;

            const mom = momentum[i];
            const atrVal = atr[i];

            if (mom === null || atrVal === null || atrVal === 0) return null;

            // Buy: Momentum > atrMultiplier * ATR (upward move exceeds volatility-adjusted threshold)
            if (mom > atrMultiplier * atrVal) {
                return createBuySignal(cleanData, i, "Momentum Threshold Break Long");
            }

            // Sell: Momentum < -atrMultiplier * ATR (downward move exceeds volatility-adjusted threshold)
            if (mom < -atrMultiplier * atrVal) {
                return createSellSignal(cleanData, i, "Momentum Threshold Break Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        momentum_threshold_break.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["momentumPeriod", "atrMultiplier"] } };
