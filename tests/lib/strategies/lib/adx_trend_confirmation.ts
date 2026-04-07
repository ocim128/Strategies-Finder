import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateADX } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawAdxThreshold = Number(params.adxThreshold ?? 25);

    return {
        ...params,
        adxPeriod: Math.max(5, Math.round(params.adxPeriod ?? 14)),
        adxThreshold: Math.max(15, Math.min(50, Number.isFinite(rawAdxThreshold) ? rawAdxThreshold : 25)) };
}

type PreparedData = {
    cleanData: OHLCVData[];
    adx: (number | null)[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        adx: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const adx_trend_confirmation: Strategy = {
    name: "ADX Trend Confirmation",
    description: "ADX measures the strength of directional movement regardless of direction. When ADX rises above a threshold, a trend is confirmed to exist.",
    defaultParams: {
        adxPeriod: 14,
        adxThreshold: 25 },
    paramLabels: {
        adxPeriod: "ADX Period",
        adxThreshold: "ADX Threshold" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const adxPeriod = Math.max(5, Math.round(params.adxPeriod ?? 14));
        const adxThreshold = Number(params.adxThreshold ?? 25);

        if (cleanData.length < adxPeriod * 2 + 2) return [];

        // Calculate ADX
        let adx = prepared.adx;
        if (adx.length === 0 || (adx[0] === null)) {
            const highs = getHighs(cleanData);
            const lows = getLows(cleanData);
            const closes = getCloses(cleanData);
            adx = calculateADX(highs, lows, closes, adxPeriod);
            prepared.adx = adx;
        }

        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            const currentAdx = adx[i];
            const prevAdx = adx[i - 1];
            const currentClose = closes[i];
            const prevClose = closes[i - 1];

            if (currentAdx === null || prevAdx === null || currentClose === null || prevClose === null) return null;

            // Buy: ADX above threshold AND rising AND close higher than previous
            if (currentAdx > adxThreshold && currentAdx > prevAdx && currentClose > prevClose) {
                return createBuySignal(cleanData, i, "ADX Trend Confirmation Long");
            }

            // Sell: ADX above threshold AND rising AND close lower than previous
            if (currentAdx > adxThreshold && currentAdx > prevAdx && currentClose < prevClose) {
                return createSellSignal(cleanData, i, "ADX Trend Confirmation Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        adx_trend_confirmation.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["adxPeriod", "adxThreshold"] } };
