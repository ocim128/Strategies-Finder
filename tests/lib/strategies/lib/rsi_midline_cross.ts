import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateRSI } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        rsiPeriod: Math.max(2, Math.round(params.rsiPeriod ?? 14)) };
}

type PreparedData = {
    cleanData: OHLCVData[];
    rsi: (number | null)[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        rsi: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const rsi_midline_cross: Strategy = {
    name: "RSI Midline Cross",
    description: "RSI crossing 50 marks the inflection where average gains overtook average losses (or vice versa).",
    defaultParams: {
        rsiPeriod: 14 },
    paramLabels: {
        rsiPeriod: "RSI Period" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const rsiPeriod = Math.max(2, Math.round(params.rsiPeriod ?? 14));

        if (cleanData.length < rsiPeriod + 2) return [];

        // Calculate RSI
        let rsi = prepared.rsi;
        if (rsi.length === 0 || (rsi[0] === null)) {
            const closes = getCloses(cleanData);
            rsi = calculateRSI(closes, rsiPeriod);
            prepared.rsi = rsi;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            const currentRsi = rsi[i];
            const prevRsi = rsi[i - 1];

            if (currentRsi === null || prevRsi === null) return null;

            // Buy: RSI crosses from below 50 to above 50
            if (prevRsi < 50 && currentRsi >= 50) {
                return createBuySignal(cleanData, i, "RSI Midline Cross Long");
            }

            // Sell: RSI crosses from above 50 to below 50
            if (prevRsi >= 50 && currentRsi < 50) {
                return createSellSignal(cleanData, i, "RSI Midline Cross Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        rsi_midline_cross.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["rsiPeriod"] } };
