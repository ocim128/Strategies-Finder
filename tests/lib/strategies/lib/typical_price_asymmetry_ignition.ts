import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { buildRollingSkewness, buildRateOfChange } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming typical price returns skewness can be computed causally and typical price rate of change aligns correctly.
// #SUGGEST_VERIFY: Verify rate of change returns valid values and skewness does not fail on uniform return periods.
function normalizeTypicalPriceAsymmetryIgnitionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        skewThreshold: Math.max(0.01, Number(params.skewThreshold ?? 1.2)),
    };
}

export const typical_price_asymmetry_ignition: Strategy = {
    name: "Typical Price Asymmetry Ignition",
    description: "Captures early momentum by tracking shifts in rolling skewness of typical price returns alongside typical price rate of change.",
    defaultParams: {
        lookback: 40,
        skewThreshold: 1.2,
    },
    paramLabels: {
        lookback: "Lookback",
        skewThreshold: "Skew Threshold",
    },
    normalizeParams: normalizeTypicalPriceAsymmetryIgnitionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalPriceAsymmetryIgnitionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const typical = getTypicalPrices(cleanData);
        
        // Calculate typical price returns
        const returns: number[] = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            returns[i] = typical[i] - typical[i - 1];
        }

        const skewness = buildRollingSkewness(returns, lookback);
        const roc = buildRateOfChange(typical, lookback);

        return createSignalLoop(cleanData, [skewness, roc], (i) => {
            if (i < lookback) return null;
            const currentSkew = skewness[i];
            const currentRoc = roc[i];

            if (currentSkew === null || currentRoc === null) return null;

            // Buy: Skewness of typical price returns is positive and above skewThreshold, and typical price rate of change is positive
            if (currentSkew > p.skewThreshold && currentRoc > 0) {
                return createBuySignal(cleanData, i, `Typical Price Skew Bullish (skew=${currentSkew.toFixed(2)}, roc=${(currentRoc * 100).toFixed(2)}%)`);
            }

            // Sell: Skewness of typical price returns is negative and below minus skewThreshold, and typical price rate of change is negative
            if (currentSkew < -(p.skewThreshold as number) && currentRoc < 0) {
                return createSellSignal(cleanData, i, `Typical Price Skew Bearish (skew=${currentSkew.toFixed(2)}, roc=${(currentRoc * 100).toFixed(2)}%)`);
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
