import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildRollingAutoCorrelation,
    buildRollingStdDev,
    buildPercentileRank,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming negative return autocorrelation identifies a high-noise mean-reverting regime.
// #SUGGEST_VERIFY: Verify standard deviation percentile (top 30%) effectively isolates high-volatility regimes.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        maxAutoCorr: Math.min(-0.01, Number(params.maxAutoCorr ?? -0.3)),
    };
}

export const autocorrelation_reversion_volatility_gated: Strategy = {
    name: "Autocorrelation Reversion Volatility Gated",
    description: "Enters reversion swings when return autocorrelation is strongly negative under high return volatility.",
    defaultParams: {
        lookback: 30,
        maxAutoCorr: -0.3,
    },
    paramLabels: {
        lookback: "Lookback",
        maxAutoCorr: "Max Autocorrelation",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const maxAutoCorr = p.maxAutoCorr as number;
        if (cleanData.length < lookback + 1) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const autoCorr = buildRollingAutoCorrelation(returns, lookback, 1);
        const stdDev = buildRollingStdDev(returns, lookback);

        // Sanitize stdDev nulls to 0
        const sanitizedStdDev = stdDev.map(v => v ?? 0);
        const volPercentiles = buildPercentileRank(sanitizedStdDev, lookback);

        return createSignalLoop(cleanData, [autoCorr, volPercentiles], (i) => {
            const ac = autoCorr[i];
            const vp = volPercentiles[i];
            const currentBar = cleanData[i];

            if (ac === null || vp === null) return null;

            // Trigger reversion only when autocorrelation is negative and volatility is in top 30%
            if (ac < maxAutoCorr && vp >= 0.70) {
                // Buy: Close is below Open (down bar, fade it)
                if (currentBar.close < currentBar.open) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish reversion: negative autoCorr (${ac.toFixed(2)}) with high volatility percentile (${(vp * 100).toFixed(0)}%)`
                    );
                }
                // Sell: Close is above Open (up bar, fade it)
                if (currentBar.close > currentBar.open) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish reversion: negative autoCorr (${ac.toFixed(2)}) with high volatility percentile (${(vp * 100).toFixed(0)}%)`
                    );
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxAutoCorr"],
    },
};
