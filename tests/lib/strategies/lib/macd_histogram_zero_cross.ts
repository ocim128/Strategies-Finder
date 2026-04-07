import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateMACD } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        fastPeriod: Math.max(2, Math.round(params.fastPeriod ?? 12)),
        slowPeriod: Math.max(2, Math.round(params.slowPeriod ?? 26)) };
}

type PreparedData = {
    cleanData: OHLCVData[];
    macdResult: { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] };
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        macdResult: { macd: [], signal: [], histogram: [] } };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const macd_histogram_zero_cross: Strategy = {
    name: "MACD Histogram Zero Cross",
    description: "MACD histogram measures the gap between the MACD line and its signal line. When histogram crosses zero, the faster momentum has overtaken the slower one.",
    defaultParams: {
        fastPeriod: 12,
        slowPeriod: 26 },
    paramLabels: {
        fastPeriod: "Fast Period",
        slowPeriod: "Slow Period" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const fastPeriod = Math.max(2, Math.round(params.fastPeriod ?? 12));
        const slowPeriod = Math.max(2, Math.round(params.slowPeriod ?? 26));

        if (fastPeriod >= slowPeriod || cleanData.length < slowPeriod + 2) return [];

        // Calculate MACD with signal period hardcoded to 9
        let macdResult = prepared.macdResult;
        if (macdResult.histogram.length === 0) {
            const closes = getCloses(cleanData);
            macdResult = calculateMACD(closes, fastPeriod, slowPeriod, 9);
            prepared.macdResult = macdResult;
        }

        const { histogram } = macdResult;

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            const currentHist = histogram[i];
            const prevHist = histogram[i - 1];

            if (currentHist === null || prevHist === null) return null;

            // Buy: Histogram crosses from negative to positive
            if (prevHist < 0 && currentHist >= 0) {
                return createBuySignal(cleanData, i, "MACD Histogram Zero Cross Long");
            }

            // Sell: Histogram crosses from positive to negative
            if (prevHist >= 0 && currentHist < 0) {
                return createSellSignal(cleanData, i, "MACD Histogram Zero Cross Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        macd_histogram_zero_cross.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fastPeriod", "slowPeriod"] } };
