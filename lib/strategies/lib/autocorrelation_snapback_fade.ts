import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingAutoCorrelation, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawNegativeAutoCorr = Number(params.negativeAutoCorr ?? -0.5);
    const rawZscoreLimit = Number(params.zscoreLimit ?? 2.0);

    return {
        ...params,
        lookback: Math.max(3, Math.round(params.lookback ?? 30)),
        negativeAutoCorr: Math.max(-1, Math.min(0, Number.isFinite(rawNegativeAutoCorr) ? rawNegativeAutoCorr : -0.5)),
        zscoreLimit: Math.abs(Number.isFinite(rawZscoreLimit) ? rawZscoreLimit : 2.0) };
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

type PreparedData = {
    cleanData: OHLCVData[];
    closes: number[];
    autocorrelation: number[];
    closeZscore: number[];
    closeLocation: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    return {
        cleanData,
        closes,
        autocorrelation: [],
        closeZscore: [],
        closeLocation: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const autocorrelation_snapback_fade: Strategy = {
    name: "Autocorrelation Snapback Fade",
    description: "Locates environments of extreme negative autocorrelation (perfect oscillating chop), and mechanically fades any price that deviates more than 2 standard deviations from the mean.",
    defaultParams: {
        lookback: 30,
        negativeAutoCorr: -0.5,
        zscoreLimit: 2.0 },
    paramLabels: {
        lookback: "Window",
        negativeAutoCorr: "Negative Autocorr",
        zscoreLimit: "Z-Score Limit" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData, closes } = prepared;

        const lookback = Math.max(3, Math.round(params.lookback ?? 30));
        const negativeAutoCorr = Number(params.negativeAutoCorr ?? -0.5);
        const zscoreLimit = Number(params.zscoreLimit ?? 2.0);

        if (cleanData.length < lookback + 2) return [];

        // Calculate autocorrelation on closes
        let autocorrelation = prepared.autocorrelation;
        if (autocorrelation.length === 0) {
            autocorrelation = normalizeSeries(buildRollingAutoCorrelation(closes, lookback, 1));
            prepared.autocorrelation = autocorrelation;
        }

        // Calculate Z-Score of closes
        let closeZscore = prepared.closeZscore;
        if (closeZscore.length === 0) {
            closeZscore = normalizeSeries(buildRollingZScore(closes, lookback));
            prepared.closeZscore = closeZscore;
        }

        // Calculate close location
        let closeLocation = prepared.closeLocation;
        if (closeLocation.length === 0) {
            closeLocation = cleanData.map(bar => {
                const range = bar.high - bar.low;
                if (range <= 0) return 0.5;
                return (bar.close - bar.low) / range;
            });
            prepared.closeLocation = closeLocation;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + 1) return null;

            const autocorr = autocorrelation[i];
            const zscore = closeZscore[i];
            const cLoc = closeLocation[i];

            if (autocorr === null || zscore === null || cLoc === null) return null;

            // Buy: negative autocorrelation AND Z-Score is very low (price far below mean) AND close location > 0.5
            if (autocorr < negativeAutoCorr && zscore < -zscoreLimit && cLoc > 0.5) {
                return createBuySignal(cleanData, i, "Autocorrelation Snapback Fade Long");
            }

            // Sell: negative autocorrelation AND Z-Score is very high (price far above mean) AND close location < 0.5
            if (autocorr < negativeAutoCorr && zscore > zscoreLimit && cLoc < 0.5) {
                return createSellSignal(cleanData, i, "Autocorrelation Snapback Fade Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        autocorrelation_snapback_fade.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "negativeAutoCorr", "zscoreLimit"] } };
