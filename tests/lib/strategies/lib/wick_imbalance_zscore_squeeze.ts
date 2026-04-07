import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawZscoreExtreme = Number(params.zscoreExtreme ?? 2.0);
    const rawBodyPctThreshold = Number(params.bodyPctThreshold ?? 0.75);

    return {
        ...params,
        zscoreLookback: Math.max(3, Math.round(params.zscoreLookback ?? 50)),
        zscoreExtreme: Math.abs(Number.isFinite(rawZscoreExtreme) ? rawZscoreExtreme : 2.0),
        bodyPctThreshold: Math.max(0, Math.min(1, Number.isFinite(rawBodyPctThreshold) ? rawBodyPctThreshold : 0.75)) };
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

type PreparedData = {
    cleanData: OHLCVData[];
    wickImbalance: number[];
    wickImbalanceZscore: number[];
    bodyPct: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        wickImbalance: [],
        wickImbalanceZscore: [],
        bodyPct: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const wick_imbalance_zscore_squeeze: Strategy = {
    name: "Wick Imbalance Z-Score Squeeze",
    description: "Identifies highly compressed statistical tension by tracking when the wick imbalance Z-score reaches extreme standard deviations, entering on the first commanding solid-body breakout.",
    defaultParams: {
        zscoreLookback: 50,
        zscoreExtreme: 2.0,
        bodyPctThreshold: 0.75 },
    paramLabels: {
        zscoreLookback: "Z-Score Lookback",
        zscoreExtreme: "Z-Score Extreme",
        bodyPctThreshold: "Body Pct Threshold" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const zscoreLookback = Math.max(3, Math.round(params.zscoreLookback ?? 50));
        const zscoreExtreme = Number(params.zscoreExtreme ?? 2.0);
        const bodyPctThreshold = Number(params.bodyPctThreshold ?? 0.75);

        if (cleanData.length < zscoreLookback + 2) return [];

        // Calculate wick imbalance: (upperWick - lowerWick) / range
        // Positive = upper wick dominance, Negative = lower wick dominance
        let wickImbalance = prepared.wickImbalance;
        if (wickImbalance.length === 0) {
            wickImbalance = cleanData.map(bar => {
                const range = bar.high - bar.low;
                if (range <= 0) return 0;
                const bodyHigh = Math.max(bar.open, bar.close);
                const bodyLow = Math.min(bar.open, bar.close);
                const upperWick = bar.high - bodyHigh;
                const lowerWick = bodyLow - bar.low;
                return (upperWick - lowerWick) / range;
            });
            prepared.wickImbalance = wickImbalance;
        }

        // Calculate Z-Score of wick imbalance
        let wickImbalanceZscore = prepared.wickImbalanceZscore;
        if (wickImbalanceZscore.length === 0) {
            wickImbalanceZscore = normalizeSeries(buildRollingZScore(wickImbalance, zscoreLookback));
            prepared.wickImbalanceZscore = wickImbalanceZscore;
        }

        // Get body percentage
        let bodyPct = prepared.bodyPct;
        if (bodyPct.length === 0) {
            bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
            prepared.bodyPct = bodyPct;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < zscoreLookback + 1) return null;

            const prevZscore = wickImbalanceZscore[i - 1];
            const currentZscore = wickImbalanceZscore[i];
            const currentBodyPct = bodyPct[i];
            const isBullish = cleanData[i].close > cleanData[i].open;
            const isBearish = cleanData[i].close < cleanData[i].open;

            if (prevZscore === null || currentZscore === null || currentBodyPct === null) return null;

            // Buy: previous Z-Score was extremely negative (lower wick dominance - absorption)
            // AND current bar has strong bullish body (release)
            if (prevZscore < -zscoreExtreme && currentBodyPct > bodyPctThreshold && isBullish) {
                return createBuySignal(cleanData, i, "Wick Imbalance Z-Score Squeeze Long");
            }

            // Sell: previous Z-Score was extremely positive (upper wick dominance - absorption)
            // AND current bar has strong bearish body (release)
            if (prevZscore > zscoreExtreme && currentBodyPct > bodyPctThreshold && isBearish) {
                return createSellSignal(cleanData, i, "Wick Imbalance Z-Score Squeeze Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        wick_imbalance_zscore_squeeze.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["zscoreLookback", "zscoreExtreme", "bodyPctThreshold"] } };
