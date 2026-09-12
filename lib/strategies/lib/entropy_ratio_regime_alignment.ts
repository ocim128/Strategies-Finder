import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

const FIXED_FAST_ENTROPY_WINDOW = 0;
const FIXED_ENTROPY_RATIO_THRESHOLD = 2;

type EntropyRatioPrepared = {
    cleanData: OHLCVData[];
    closes: number[];
    medianByWindow: Map<number, number[]>;
};

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

function prepareEntropyRatioData(data: OHLCVData[]): EntropyRatioPrepared {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    return {
        cleanData,
        closes,
        medianByWindow: new Map<number, number[]>() };
}

function getPreparedEntropyRatioData(preparedData: unknown, data: OHLCVData[]): EntropyRatioPrepared {
    if (preparedData && typeof preparedData === "object" && "medianByWindow" in preparedData) {
        return preparedData as EntropyRatioPrepared;
    }
    return prepareEntropyRatioData(data);
}

function normalizeEntropyRatioParams(params: StrategyParams): StrategyParams {
    const rawSlowWindow = Number(params.slowWindow ?? 30);
    const slowWindow = Math.max(2, Math.round(Number.isFinite(rawSlowWindow) ? rawSlowWindow : 30));

    return {
        slowWindow };
}

export const entropy_ratio_regime_alignment: Strategy = {
    name: "Entropy Ratio Regime Alignment",
    description: `Trendable regimes are filtered by a fixed entropy-ratio gate (fast=${FIXED_FAST_ENTROPY_WINDOW}, threshold=${FIXED_ENTROPY_RATIO_THRESHOLD}) and enter when price aligns with its slow rolling median.`,
    defaultParams: {
        slowWindow: 30 },
    paramLabels: {
        slowWindow: "Slow Entropy & Median Window" },
    normalizeParams: normalizeEntropyRatioParams,
    prepareFinderData: (data) => prepareEntropyRatioData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedEntropyRatioData(preparedData, data);
        const { cleanData, closes, medianByWindow } = prepared;
        const normalizedParams = normalizeEntropyRatioParams(params);
        const slowWindow = normalizedParams.slowWindow;

        const maxLookback = slowWindow;
        if (cleanData.length < maxLookback + 2) return [];

        let medians = medianByWindow.get(slowWindow);
        if (!medians) {
            medians = normalizeSeries(buildRollingMedian(closes, slowWindow));
            medianByWindow.set(slowWindow, medians);
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < maxLookback) return null;

            // With fast entropy fixed to 0 and the threshold fixed to 2, the
            // entropy-ratio gate is always permissive. Keep the strategy aligned
            // to its remaining slow-window median contract.
            if (closes[i] > medians[i]) {
                return createBuySignal(cleanData, i, "Entropy Ratio Align Long");
            }
            if (closes[i] < medians[i]) {
                return createSellSignal(cleanData, i, "Entropy Ratio Align Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        entropy_ratio_regime_alignment.executePrepared?.(prepareEntropyRatioData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["slowWindow"] } };





