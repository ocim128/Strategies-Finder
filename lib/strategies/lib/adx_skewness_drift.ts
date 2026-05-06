import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateADX } from "../indicators";
import { buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeAdxSkewnessDriftParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        adxPeriod: Math.max(2, Math.round(params.adxPeriod ?? 14)),
        adxThresh: Math.max(0, Number(params.adxThresh ?? 25)),
        skewThreshold: Math.max(0, Math.abs(Number(params.skewThreshold ?? 0.5))) };
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
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const normalizedParams = normalizeAdxSkewnessDriftParams(params);
        const adxPeriod = normalizedParams.adxPeriod as number;
        const adxThresh = normalizedParams.adxThresh as number;
        const skewThreshold = normalizedParams.skewThreshold as number;
        const cleanData = ensureCleanData(data);
        if (cleanData.length < adxPeriod * 2) return [];

        const adx = calculateADX(
            cleanData.map(d => d.high),
            cleanData.map(d => d.low),
            cleanData.map(d => d.close),
            adxPeriod
        );

        const returnSeries = extractBarMetricSeries(cleanData, "closeReturn");
        // Keep zero-return samples from collapsing skewness while preserving deterministic execution.
        const mappedReturns = returnSeries.map((r, index) => r === 0 ? (index % 2 === 0 ? -0.00000005 : 0.00000005) : r);
        const skewness = buildRollingSkewness(mappedReturns, Math.max(20, adxPeriod));

        return createSignalLoop(cleanData, [], (i) => {
            if (adx[i] === null || skewness[i] === null) return null;

            const currentAdx = adx[i]!;
            const currentSkew = skewness[i]!;
            
            const isTrending = currentAdx > adxThresh;
            
            if (isTrending && currentSkew > skewThreshold) {
                return createBuySignal(cleanData, i, `ADX Trending > ${adxThresh} & positive skew`);
            }
            if (isTrending && currentSkew < -skewThreshold) {
                return createSellSignal(cleanData, i, `ADX Trending > ${adxThresh} & negative skew`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["adxPeriod", "adxThresh", "skewThreshold"] } };
