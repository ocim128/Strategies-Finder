import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateBollingerBands } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawBbMult = Number(params.bbMult ?? 2.0);

    return {
        ...params,
        bbPeriod: Math.max(5, Math.round(params.bbPeriod ?? 20)),
        bbMult: Math.max(1.0, Math.min(4.0, Number.isFinite(rawBbMult) ? rawBbMult : 2.0)) };
}

type PreparedData = {
    cleanData: OHLCVData[];
    bollingerBands: { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] };
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        bollingerBands: { upper: [], middle: [], lower: [] } };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const bollinger_touch_reversion: Strategy = {
    name: "Bollinger Touch Reversion",
    description: "When price touches the Bollinger lower band, it is at least 2 standard deviations below its own rolling mean — a statistically extreme event.",
    defaultParams: {
        bbPeriod: 20,
        bbMult: 2.0 },
    paramLabels: {
        bbPeriod: "BB Period",
        bbMult: "BB Multiplier" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const bbPeriod = Math.max(5, Math.round(params.bbPeriod ?? 20));
        const bbMult = Number(params.bbMult ?? 2.0);

        if (cleanData.length < bbPeriod + 2) return [];

        // Calculate Bollinger Bands
        let bollingerBands = prepared.bollingerBands;
        if (bollingerBands.upper.length === 0) {
            const closes = getCloses(cleanData);
            bollingerBands = calculateBollingerBands(closes, bbPeriod, bbMult);
            prepared.bollingerBands = bollingerBands;
        }

        const { upper, lower } = bollingerBands;
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < bbPeriod + 1) return null;

            const close = closes[i];
            const lowerBand = lower[i];
            const upperBand = upper[i];

            if (close === null || lowerBand === null || upperBand === null) return null;

            // Buy: Close at or below lower Bollinger Band
            if (close <= lowerBand) {
                return createBuySignal(cleanData, i, "Bollinger Touch Reversion Long");
            }

            // Sell: Close at or above upper Bollinger Band
            if (close >= upperBand) {
                return createSellSignal(cleanData, i, "Bollinger Touch Reversion Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        bollinger_touch_reversion.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["bbPeriod", "bbMult"] } };
