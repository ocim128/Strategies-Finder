import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateADX } from "../indicators";
import { buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

export const adx_skewness_drift: Strategy = {
    name: "ADX Skewness Drift",
    description: "Resolves the primary limitation of ADX—its lack of directionality—by overlaying rolling structural skewness. Defines trading regimes using raw unipolar trend momentum validated by an asymmetrically biased return distribution.",
    defaultParams: {
        adxPeriod: 14,
        adxThresh: 25,
        skewThreshold: 0.5,
    },
    paramLabels: {
        adxPeriod: "ADX Period",
        adxThresh: "Trend Strength Level",
        skewThreshold: "Asymmetry Boundary",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < (params.adxPeriod as number) * 2) return [];

        const adx = calculateADX(
            cleanData.map(d => d.high),
            cleanData.map(d => d.low),
            cleanData.map(d => d.close),
            params.adxPeriod as number
        );

        const returnSeries = extractBarMetricSeries(cleanData, "closeReturn");
        // Remove strictly zero return samples that destroy skewness tracking over weekends/crypto pegs
        const mappedReturns = returnSeries.map(r => r === 0 ? 0.0000001 * (Math.random() - 0.5) : r);
        const skewness = buildRollingSkewness(mappedReturns, Math.max(20, params.adxPeriod as number));

        return createSignalLoop(cleanData, [], (i) => {
            if (adx[i] === null || skewness[i] === null) return null;

            const currentAdx = adx[i]!;
            const currentSkew = skewness[i]!;
            
            const isTrending = currentAdx > (params.adxThresh as number);
            
            if (isTrending && currentSkew > (params.skewThreshold as number)) {
                return createBuySignal(cleanData, i, `ADX Trending > ${params.adxThresh} & positive skew`);
            }
            if (isTrending && currentSkew < -(params.skewThreshold as number)) {
                return createSellSignal(cleanData, i, `ADX Trending > ${params.adxThresh} & negative skew`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["adxPeriod", "adxThresh", "skewThreshold"],
    },
};
