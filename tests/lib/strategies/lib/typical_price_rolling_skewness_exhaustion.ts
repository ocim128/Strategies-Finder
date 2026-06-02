import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getTypicalPrices } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildRollingSkewness } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming rolling return skewness of typical price capitulation followed by median cross is a stable reversion edge.
// #SUGGEST_VERIFY: Verify return skewness and close acceptance arrays align correctly without any off-by-one indicators.
function normalizeTypicalPriceRollingSkewnessExhaustionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 45))),
        skewThreshold: Math.max(0.1, Number(params.skewThreshold ?? 1.3)),
    };
}

export const typical_price_rolling_skewness_exhaustion: Strategy = {
    name: "Typical Price Rolling Skewness Exhaustion",
    description: "Signals reversion when extreme rolling typical price skewness is accompanied by price acceptance back across the rolling median.",
    defaultParams: {
        lookback: 45,
        skewThreshold: 1.3,
    },
    paramLabels: {
        lookback: "Lookback Window",
        skewThreshold: "Skewness Threshold",
    },
    normalizeParams: normalizeTypicalPriceRollingSkewnessExhaustionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalPriceRollingSkewnessExhaustionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);

        // Typical price returns
        const typicalReturns: number[] = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            typicalReturns[i] = typical[i] - typical[i - 1];
        }

        const skewness = buildRollingSkewness(typicalReturns, lookback);
        const median = buildRollingMedian(closes, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [skewness, median, closeAcceptance], (i) => {
            if (i < lookback) return null;
            const currentSkew = skewness[i];
            const currentMedian = median[i];
            const acc = closeAcceptance[i];

            if (currentSkew === null || currentMedian === null || acc === null) return null;

            // Buy logic: Rolling skewness is greater than skewThreshold, and close price accepts below the rolling median (acc < 0)
            if (currentSkew > p.skewThreshold && acc < 0) {
                return createBuySignal(cleanData, i, `Bullish Skewness Reversion (skew=${currentSkew.toFixed(2)}, median=${currentMedian.toFixed(2)})`);
            }

            // Sell logic: Rolling skewness is less than minus skewThreshold, and close price accepts above the rolling median (acc > 0)
            if (currentSkew < -(p.skewThreshold as number) && acc > 0) {
                return createSellSignal(cleanData, i, `Bearish Skewness Reversion (skew=${currentSkew.toFixed(2)}, median=${currentMedian.toFixed(2)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold"],
    },
};
