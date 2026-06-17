import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    checkCrossover,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    const shortLookback = Math.max(3, Math.round(Number(params.shortLookback ?? 15)));
    const longLookback = Math.max(shortLookback + 2, Math.round(Number(params.longLookback ?? 45)));
    return {
        ...params,
        shortLookback,
        longLookback,
    };
}

export const autocorrelation_crossover_momentum: Strategy = {
    name: "Autocorrelation Crossover Momentum",
    description: "Follows trend direction when short-term return autocorrelation crosses above long-term return autocorrelation.",
    defaultParams: {
        shortLookback: 15,
        longLookback: 45,
    },
    paramLabels: {
        shortLookback: "Short Autocorrelation Window",
        longLookback: "Long Autocorrelation Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const shortLookback = p.shortLookback as number;
        const longLookback = p.longLookback as number;
        if (cleanData.length < longLookback) return [];

        const closes = getCloses(cleanData);
        const roc1 = buildRateOfChange(closes, 1);
        const returns = roc1.map((v) => v ?? 0);

        const shortAC = buildRollingAutoCorrelation(returns, shortLookback, 1);
        const longAC = buildRollingAutoCorrelation(returns, longLookback, 1);

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");

        return createSignalLoop(cleanData, [shortAC, longAC], (i) => {
            if (i < 1) return null;
            const crossover = checkCrossover(shortAC, longAC, i);
            if (crossover !== "bullish") return null;

            const cr = closeReturn[i];

            // Buy: short AC crossed above long AC, and close return is positive
            if (cr > 0) {
                return createBuySignal(cleanData, i, `Autocorrelation crossover buy: Short AC crossed above Long AC`);
            }
            // Sell: short AC crossed above long AC, and close return is negative
            if (cr < 0) {
                return createSellSignal(cleanData, i, `Autocorrelation crossover sell: Short AC crossed above Long AC`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["shortLookback", "longLookback"],
    },
};
