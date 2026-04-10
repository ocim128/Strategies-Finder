import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeAutocorrelationMomentumDivergenceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        auto_lookback: Math.max(3, Math.round(params.auto_lookback ?? 20)),
        auto_min: Math.max(0, Math.min(1, Number(params.auto_min ?? 0.6))),
        roc_lookback: Math.max(1, Math.round(params.roc_lookback ?? 5))
    };
}

export const autocorrelation_momentum_divergence: Strategy = {
    name: "Autocorrelation Momentum Divergence",
    description: "If return autocorrelation remains dangerously high (retail perceives a perfect trend), but the raw rate-of-change crosses zero against them, the trend is an illusion running on fumes.",
    defaultParams: {
        auto_lookback: 20,
        auto_min: 0.6,
        roc_lookback: 5
    },
    paramLabels: {
        auto_lookback: "Autocorrelation Lookback",
        auto_min: "Min Autocorrelation",
        roc_lookback: "ROC Lookback"
    },
    normalizeParams: normalizeAutocorrelationMomentumDivergenceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAutocorrelationMomentumDivergenceParams(params);
        const autoLookback = p.auto_lookback as number;
        const rocLookback = p.roc_lookback as number;
        
        if (cleanData.length < Math.max(autoLookback, rocLookback) * 2) return [];

        const closes = getCloses(cleanData);
        // buildRollingAutoCorrelation takes the data array, not returns, though the prompt talks about "return autocorrelation". 
        // Core lib usually computes it directly on the series.
        const returns = buildRateOfChange(closes, 1).map(v => v ?? 0);
        const autocorrelation = buildRollingAutoCorrelation(returns, autoLookback);
        const roc = buildRateOfChange(closes, rocLookback);

        return createSignalLoop(cleanData, [autocorrelation, roc], (i) => {
            if (i < 1 || autocorrelation[i] === null || roc[i] === null || roc[i-1] === null) return null;
            
            const autoC = autocorrelation[i]!;
            const currRoc = roc[i]!;
            const prevRoc = roc[i-1]!;
            
            const aMin = p.auto_min as number;

            if (autoC > aMin && prevRoc <= 0 && currRoc > 0) {
                return createBuySignal(cleanData, i, `Autocorrelation ${autoC.toFixed(2)}, ROC crossed above 0`);
            }
            if (autoC > aMin && prevRoc >= 0 && currRoc < 0) {
                return createSellSignal(cleanData, i, `Autocorrelation ${autoC.toFixed(2)}, ROC crossed below 0`);
            }
            
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["auto_lookback", "auto_min", "roc_lookback"]
    }
};
