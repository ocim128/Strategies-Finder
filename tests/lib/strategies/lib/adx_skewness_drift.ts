import { Strategy, OHLCVData, Signal, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateADX } from "../indicators";
import { buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

type AdxSkewnessDriftPrepared = {
    data: OHLCVData[];
    highs: number[];
    lows: number[];
    closes: number[];
    mappedReturns: number[];
    adxByPeriod: Map<number, (number | null)[]>;
    skewnessByLookback: Map<number, (number | null)[]>;
};

function normalizeAdxSkewnessDriftParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        adxPeriod: Math.max(2, Math.round(params.adxPeriod ?? 14)),
        adxThresh: Math.max(0, Number(params.adxThresh ?? 25)),
        skewThreshold: Math.max(0, Math.abs(Number(params.skewThreshold ?? 0.5))) };
}

function prepareAdxSkewnessDriftData(data: OHLCVData[]): AdxSkewnessDriftPrepared {
    const cleanData = ensureCleanData(data);
    const returnSeries = extractBarMetricSeries(cleanData, "closeReturn");
    return {
        data: cleanData,
        highs: getHighs(cleanData),
        lows: getLows(cleanData),
        closes: getCloses(cleanData),
        mappedReturns: returnSeries.map((r, index) => r === 0 ? (index % 2 === 0 ? -0.00000005 : 0.00000005) : r),
        adxByPeriod: new Map<number, (number | null)[]>(),
        skewnessByLookback: new Map<number, (number | null)[]>(),
    };
}

function getPreparedAdxSkewnessDriftData(preparedData: unknown, data: OHLCVData[]): AdxSkewnessDriftPrepared {
    if (preparedData && typeof preparedData === "object" && "adxByPeriod" in preparedData && "skewnessByLookback" in preparedData) {
        return preparedData as AdxSkewnessDriftPrepared;
    }
    return prepareAdxSkewnessDriftData(data);
}

function executeAdxSkewnessDriftPrepared(prepared: AdxSkewnessDriftPrepared, params: StrategyParams): Signal[] {
    const normalizedParams = normalizeAdxSkewnessDriftParams(params);
    const adxPeriod = normalizedParams.adxPeriod as number;
    const adxThresh = normalizedParams.adxThresh as number;
    const skewThreshold = normalizedParams.skewThreshold as number;
    const data = prepared.data;
    if (data.length < adxPeriod * 2) return [];

    let adx = prepared.adxByPeriod.get(adxPeriod);
    if (!adx) {
        adx = calculateADX(prepared.highs, prepared.lows, prepared.closes, adxPeriod);
        prepared.adxByPeriod.set(adxPeriod, adx);
    }

    const skewLookback = Math.max(20, adxPeriod);
    let skewness = prepared.skewnessByLookback.get(skewLookback);
    if (!skewness) {
        skewness = buildRollingSkewness(prepared.mappedReturns, skewLookback);
        prepared.skewnessByLookback.set(skewLookback, skewness);
    }

    const signals: Signal[] = [];
    for (let i = 1; i < data.length; i++) {
        const currentAdx = adx[i];
        const currentSkew = skewness[i];
        if (currentAdx === null || currentSkew === null || currentAdx === undefined || currentSkew === undefined) {
            continue;
        }

        const isTrending = currentAdx > adxThresh;
        if (isTrending && currentSkew > skewThreshold) {
            signals.push(createBuySignal(data, i, `ADX Trending > ${adxThresh} & positive skew`));
        }
        if (isTrending && currentSkew < -skewThreshold) {
            signals.push(createSellSignal(data, i, `ADX Trending > ${adxThresh} & negative skew`));
        }
    }

    return signals;
}

export const adx_skewness_drift: Strategy = {
    name: "ADX Skewness Drift",
    description: "Resolves the primary limitation of ADX - its lack of directionality - by overlaying rolling structural skewness. Defines trading regimes using raw unipolar trend momentum validated by an asymmetrically biased return distribution.",
    defaultParams: {
        adxPeriod: 14,
        adxThresh: 25,
        skewThreshold: 0.5 },
    paramLabels: {
        adxPeriod: "ADX Period",
        adxThresh: "Trend Strength Level",
        skewThreshold: "Asymmetry Boundary" },
    normalizeParams: normalizeAdxSkewnessDriftParams,
    prepareFinderData: (data) => prepareAdxSkewnessDriftData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) =>
        executeAdxSkewnessDriftPrepared(getPreparedAdxSkewnessDriftData(preparedData, data), params),
    execute: (data: OHLCVData[], params: StrategyParams) =>
        executeAdxSkewnessDriftPrepared(prepareAdxSkewnessDriftData(data), params),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["adxPeriod", "adxThresh", "skewThreshold"] } };
