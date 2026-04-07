import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { calculateSMA } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawZscorePullback = Number(params.zscorePullback ?? 2.5);

    return {
        ...params,
        fastWindow: Math.max(1, Math.round(params.fastWindow ?? 5)),
        slowWindow: Math.max(2, Math.round(params.slowWindow ?? 40)),
        zscorePullback: Math.abs(Number.isFinite(rawZscorePullback) ? rawZscorePullback : 2.5) };
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

type PreparedData = {
    cleanData: OHLCVData[];
    typicalPrices: number[];
    dualTimeframeRatio: number[];
    typicalZscore: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    const typicalPrices = getTypicalPrices(cleanData);
    return {
        cleanData,
        typicalPrices,
        dualTimeframeRatio: [],
        typicalZscore: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const holographic_macro_pinch: Strategy = {
    name: "Holographic Macro Pinch",
    description: "Constructs an ultra-high Sharpe pullback by confirming the macro structure via DualTimeframeRatio, but executing exclusively when the micro-timeframe hits a statistical Z-Score exhaustion node.",
    defaultParams: {
        fastWindow: 5,
        slowWindow: 40,
        zscorePullback: 2.5 },
    paramLabels: {
        fastWindow: "Fast Window",
        slowWindow: "Slow Window",
        zscorePullback: "Z-Score Pullback" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData, typicalPrices } = prepared;

        const fastWindow = Math.max(1, Math.round(params.fastWindow ?? 5));
        const slowWindow = Math.max(2, Math.round(params.slowWindow ?? 40));
        const zscorePullback = Number(params.zscorePullback ?? 2.5);

        if (cleanData.length < slowWindow + 2) return [];

        // Calculate dual timeframe ratio (fast SMA / slow SMA of typical prices)
        let dualTimeframeRatio = prepared.dualTimeframeRatio;
        if (dualTimeframeRatio.length === 0) {
            const fastSMA = calculateSMA(typicalPrices, fastWindow);
            const slowSMA = calculateSMA(typicalPrices, slowWindow);
            dualTimeframeRatio = typicalPrices.map((_, i) => {
                const f = fastSMA[i];
                const s = slowSMA[i];
                if (f === null || s === null || s === 0) return null;
                return f / s;
            }).map(v => v ?? 0);
            prepared.dualTimeframeRatio = dualTimeframeRatio;
        }

        // Calculate Z-Score of typical prices
        let typicalZscore = prepared.typicalZscore;
        if (typicalZscore.length === 0) {
            typicalZscore = normalizeSeries(buildRollingZScore(typicalPrices, slowWindow));
            prepared.typicalZscore = typicalZscore;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < slowWindow + 1) return null;

            const ratio = dualTimeframeRatio[i];
            const zscore = typicalZscore[i];

            if (ratio === null || zscore === null) return null;

            // Buy: ratio > 1.02 (macro is bullish) AND Z-Score is very low (micro panic)
            if (ratio > 1.02 && zscore < -zscorePullback) {
                return createBuySignal(cleanData, i, "Holographic Macro Pinch Long");
            }

            // Sell: ratio < 0.98 (macro is bearish) AND Z-Score is very high (micro exuberance)
            if (ratio < 0.98 && zscore > zscorePullback) {
                return createSellSignal(cleanData, i, "Holographic Macro Pinch Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        holographic_macro_pinch.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fastWindow", "slowWindow", "zscorePullback"] } };
