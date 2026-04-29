import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingStdDev } from "./price-action-statistics-core";

function normalizeTypicalPriceDeviationFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        dev_threshold: Math.max(0.1, Math.abs(Number(params.dev_threshold ?? 2))),
    };
}

export const typical_price_deviation_fade: Strategy = {
    name: "Typical Price Deviation Fade",
    description:
        "Fades typical-price deviations that stretch multiple standard deviations away from their rolling center of gravity.",
    defaultParams: {
        lookback: 20,
        dev_threshold: 2,
    },
    paramLabels: {
        lookback: "Lookback",
        dev_threshold: "Deviation Threshold",
    },
    normalizeParams: normalizeTypicalPriceDeviationFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalPriceDeviationFadeParams(params);
        const lookback = p.lookback as number;
        const deviationThreshold = p.dev_threshold as number;
        if (cleanData.length < lookback) return [];

        const typicalPrices = getTypicalPrices(cleanData);
        const average = buildRollingAverage(typicalPrices, lookback);
        const stdDev = buildRollingStdDev(typicalPrices, lookback);

        return createSignalLoop(cleanData, [average, stdDev], (i) => {
            const mean = average[i];
            const deviation = stdDev[i];
            if (mean === null || deviation === null || deviation <= 0) return null;

            const lowerThreshold = mean - deviationThreshold * deviation;
            const upperThreshold = mean + deviationThreshold * deviation;
            if (typicalPrices[i] < lowerThreshold) {
                return createBuySignal(cleanData, i, "Typical price below lower deviation band");
            }
            if (typicalPrices[i] > upperThreshold) {
                return createSellSignal(cleanData, i, "Typical price above upper deviation band");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "dev_threshold"],
    },
};
