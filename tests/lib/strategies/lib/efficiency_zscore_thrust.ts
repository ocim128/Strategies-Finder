import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawErZScoreExtreme = Number(params.erZScoreExtreme ?? 2.5);

    return {
        ...params,
        erLookback: Math.max(2, Math.round(params.erLookback ?? 20)),
        zscoreLookback: Math.max(3, Math.round(params.zscoreLookback ?? 100)),
        erZScoreExtreme: Math.abs(Number.isFinite(rawErZScoreExtreme) ? rawErZScoreExtreme : 2.5) };
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

type PreparedData = {
    cleanData: OHLCVData[];
    efficiencyRatio: number[];
    erZscore: number[];
    bodyDirection: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        efficiencyRatio: [],
        erZscore: [],
        bodyDirection: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const efficiency_zscore_thrust: Strategy = {
    name: "Efficiency Z-Score Thrust",
    description: "Transforms Kaufman's Efficiency Ratio into a rolling Z-Score to locate regime anomalies, executing when path efficiency statistically ruptures its historical bounds.",
    defaultParams: {
        erLookback: 20,
        zscoreLookback: 100,
        erZScoreExtreme: 2.5 },
    paramLabels: {
        erLookback: "ER Lookback",
        zscoreLookback: "Z-Score Lookback",
        erZScoreExtreme: "ER Z-Score Extreme" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const erLookback = Math.max(2, Math.round(params.erLookback ?? 20));
        const zscoreLookback = Math.max(3, Math.round(params.zscoreLookback ?? 100));
        const erZScoreExtreme = Number(params.erZScoreExtreme ?? 2.5);

        if (cleanData.length < zscoreLookback + 2) return [];

        // Calculate efficiency ratio
        let efficiencyRatio = prepared.efficiencyRatio;
        if (efficiencyRatio.length === 0) {
            efficiencyRatio = normalizeSeries(buildEfficiencyRatio(cleanData, erLookback));
            prepared.efficiencyRatio = efficiencyRatio;
        }

        // Calculate Z-Score of efficiency ratio
        let erZscore = prepared.erZscore;
        if (erZscore.length === 0) {
            erZscore = normalizeSeries(buildRollingZScore(efficiencyRatio, zscoreLookback));
            prepared.erZscore = erZscore;
        }

        // Get body direction
        let bodyDirection = prepared.bodyDirection;
        if (bodyDirection.length === 0) {
            bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
            prepared.bodyDirection = bodyDirection;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < zscoreLookback + 1) return null;

            const currentZscore = erZscore[i];
            const prevZscore = erZscore[i - 1];
            const dir = bodyDirection[i];

            if (currentZscore === null || prevZscore === null || dir === null) return null;

            // Buy: Z-Score crosses above extreme threshold AND body is bullish
            if (prevZscore < erZScoreExtreme && currentZscore >= erZScoreExtreme && dir > 0) {
                return createBuySignal(cleanData, i, "Efficiency Z-Score Thrust Long");
            }

            // Sell: Z-Score crosses above extreme threshold AND body is bearish
            if (prevZscore < erZScoreExtreme && currentZscore >= erZScoreExtreme && dir < 0) {
                return createSellSignal(cleanData, i, "Efficiency Z-Score Thrust Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        efficiency_zscore_thrust.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["erLookback", "zscoreLookback", "erZScoreExtreme"] } };
