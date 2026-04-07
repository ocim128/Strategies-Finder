import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingKurtosis, buildEfficiencyRatio } from "./price-action-statistics-core";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawKurtosisExtreme = Number(params.kurtosisExtreme ?? 5.0);
    const rawErThreshold = Number(params.erThreshold ?? 0.6);

    return {
        ...params,
        lookback: Math.max(3, Math.round(params.lookback ?? 21)),
        kurtosisExtreme: Number.isFinite(rawKurtosisExtreme) ? rawKurtosisExtreme : 5.0,
        erThreshold: Math.max(0, Math.min(1, Number.isFinite(rawErThreshold) ? rawErThreshold : 0.6)) };
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

type PreparedData = {
    cleanData: OHLCVData[];
    closes: number[];
    kurtosis: number[];
    efficiencyRatio: number[];
    bodyDirection: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    return {
        cleanData,
        closes,
        kurtosis: [],
        efficiencyRatio: [],
        bodyDirection: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const kurtosis_efficiency_singularity: Strategy = {
    name: "Kurtosis Efficiency Singularity",
    description: "Targets the exact birth of non-linear trends by firing when an extreme fat-tail event (Kurtosis) coincides perfectly with high path dependency (Efficiency Ratio).",
    defaultParams: {
        lookback: 21,
        kurtosisExtreme: 5.0,
        erThreshold: 0.6 },
    paramLabels: {
        lookback: "Lookback",
        kurtosisExtreme: "Kurtosis Threshold",
        erThreshold: "Efficiency Threshold" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData, closes } = prepared;

        const lookback = Math.max(3, Math.round(params.lookback ?? 21));
        const kurtosisExtreme = Number(params.kurtosisExtreme ?? 5.0);
        const erThreshold = Number(params.erThreshold ?? 0.6);

        if (cleanData.length < lookback + 2) return [];

        // Calculate kurtosis on closes
        let kurtosis = prepared.kurtosis;
        if (kurtosis.length === 0) {
            kurtosis = normalizeSeries(buildRollingKurtosis(closes, lookback));
            prepared.kurtosis = kurtosis;
        }

        // Calculate efficiency ratio
        let efficiencyRatio = prepared.efficiencyRatio;
        if (efficiencyRatio.length === 0) {
            efficiencyRatio = normalizeSeries(buildEfficiencyRatio(cleanData, lookback));
            prepared.efficiencyRatio = efficiencyRatio;
        }

        // Get body direction
        let bodyDirection = prepared.bodyDirection;
        if (bodyDirection.length === 0) {
            bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
            prepared.bodyDirection = bodyDirection;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + 1) return null;

            const k = kurtosis[i];
            const er = efficiencyRatio[i];
            const dir = bodyDirection[i];

            if (k === null || er === null || dir === null) return null;
            if (k > kurtosisExtreme && er > erThreshold) {
                if (dir > 0) {
                    return createBuySignal(cleanData, i, "Kurtosis Efficiency Singularity Long");
                }
                if (dir < 0) {
                    return createSellSignal(cleanData, i, "Kurtosis Efficiency Singularity Short");
                }
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        kurtosis_efficiency_singularity.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "kurtosisExtreme", "erThreshold"] } };
