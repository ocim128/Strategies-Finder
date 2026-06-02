import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming volume autocorrelation acts as a robust indicator of persistent algorithmic execution.
// #SUGGEST_VERIFY: Verify volume autocorrelation calculation doesn't fail or return invalid/out-of-bounds metrics on flat volume.
function normalizeVolumeAutocorrelationRegimeBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        minCorrelation: Math.max(0.01, Math.min(0.99, Number(params.minCorrelation ?? 0.5))),
    };
}

export const volume_autocorrelation_regime_breakout: Strategy = {
    name: "Volume Autocorrelation Regime Breakout",
    description: "Filters breakout entries from trailing boundaries by demanding high serial correlation of trading volume, showing institutional footprints.",
    defaultParams: {
        lookback: 30,
        minCorrelation: 0.5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minCorrelation: "Min Volume Correlation",
    },
    normalizeParams: normalizeVolumeAutocorrelationRegimeBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeAutocorrelationRegimeBreakoutParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
        const autoCorr = buildRollingAutoCorrelation(volumes, lookback, 1);

        return createSignalLoop(cleanData, [highest, lowest, autoCorr], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const hi = highest[i];
            const lo = lowest[i];
            const corr = autoCorr[i];

            if (hi === null || lo === null || corr === null) return null;
            if (corr <= p.minCorrelation) return null;

            // Buy logic: Close is above the trailing high boundary and rolling volume autocorrelation is greater than minCorrelation.
            if (currentClose > hi) {
                return createBuySignal(cleanData, i, `Volume Autocorr Breakout Bullish (corr=${corr.toFixed(3)}, close=${currentClose.toFixed(2)}, hi=${hi.toFixed(2)})`);
            }

            // Sell logic: Close is below the trailing low boundary and rolling volume autocorrelation is greater than minCorrelation.
            if (currentClose < lo) {
                return createSellSignal(cleanData, i, `Volume Autocorr Breakout Bearish (corr=${corr.toFixed(3)}, close=${currentClose.toFixed(2)}, lo=${lo.toFixed(2)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minCorrelation"],
    },
};
