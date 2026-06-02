import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getTypicalPrices } from "../strategy-helpers";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming typical price and close price autocorrelation divergence points to micro-structure dislocations.
// #SUGGEST_VERIFY: Verify rolling autocorrelation helper behaves correctly under low volume/flat periods and does not return extreme values.
function normalizeTypicalCloseAutocorrelationDivergenceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 40))),
        divergenceThreshold: Math.max(0.01, Number(params.divergenceThreshold ?? 0.4)),
    };
}

export const typical_close_autocorrelation_divergence: Strategy = {
    name: "Typical and Close Autocorrelation Divergence",
    description: "Exposes micro-structural imbalance where typical price autocorrelation diverges from close price autocorrelation, suggesting near-term statistical reversion.",
    defaultParams: {
        lookback: 40,
        divergenceThreshold: 0.4,
    },
    paramLabels: {
        lookback: "Autocorrelation Lookback",
        divergenceThreshold: "Divergence Threshold",
    },
    normalizeParams: normalizeTypicalCloseAutocorrelationDivergenceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalCloseAutocorrelationDivergenceParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);

        const closeAuto = buildRollingAutoCorrelation(closes, lookback, 1);
        const typicalAuto = buildRollingAutoCorrelation(typical, lookback, 1);

        return createSignalLoop(cleanData, [closeAuto, typicalAuto], (i) => {
            if (i < lookback) return null;
            const ca = closeAuto[i];
            const ta = typicalAuto[i];

            if (ca === null || ta === null) return null;

            const diffTypicalMinusClose = ta - ca;
            const diffCloseMinusTypical = ca - ta;

            // Buy: Typical autocorrelation minus close autocorrelation is greater than divergenceThreshold
            if (diffTypicalMinusClose > p.divergenceThreshold) {
                return createBuySignal(cleanData, i, `Typical close autocorr divergence bullish (ta-ca=${diffTypicalMinusClose.toFixed(3)})`);
            }

            // Sell: Close autocorrelation minus typical autocorrelation is greater than divergenceThreshold
            if (diffCloseMinusTypical > p.divergenceThreshold) {
                return createSellSignal(cleanData, i, `Typical close autocorr divergence bearish (ca-ta=${diffCloseMinusTypical.toFixed(3)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "divergenceThreshold"],
    },
};
