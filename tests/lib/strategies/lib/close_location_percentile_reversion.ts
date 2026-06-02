import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingAutoCorrelation } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming rolling close-location averages and volume autocorrelation represent structural overextensions.
// #SUGGEST_VERIFY: Verify volume autocorrelation is computed causally and handles flat volume gracefully.
function normalizeCloseLocationPercentileReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 35))),
        percentileLimit: Math.max(50, Math.min(99, Number(params.percentileLimit ?? 90))),
    };
}

export const close_location_percentile_reversion: Strategy = {
    name: "Close Location Percentile Reversion",
    description: "Reverts overextended rolling close-location levels when short-term volume autocorrelation collapses.",
    defaultParams: {
        lookback: 35,
        percentileLimit: 90,
    },
    paramLabels: {
        lookback: "Lookback Window",
        percentileLimit: "Percentile Limit",
    },
    normalizeParams: normalizeCloseLocationPercentileReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCloseLocationPercentileReversionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const avgCloseLoc = buildRollingAverage(closeLocation, lookback);
        const avgCloseLocClean = avgCloseLoc.map(v => v ?? 0.5);

        const rank = buildPercentileRank(avgCloseLocClean, lookback);

        const volumes = getVolumes(cleanData);
        const volAuto = buildRollingAutoCorrelation(volumes, lookback, 1);

        const upperLimit = (p.percentileLimit as number) / 100;
        const lowerLimit = (100 - (p.percentileLimit as number)) / 100;

        return createSignalLoop(cleanData, [rank, volAuto], (i) => {
            if (i < lookback) return null;
            const currentRank = rank[i];
            const currentVolAuto = volAuto[i];

            if (currentRank === null || currentVolAuto === null) return null;

            // Reversion condition: volume autocorrelation is negative
            if (currentVolAuto < 0) {
                // Buy: Percentile rank of rolling average close location is less than 100 - percentileLimit
                if (currentRank < lowerLimit) {
                    return createBuySignal(cleanData, i, `Bullish Close Location Percentile Reversion (rank=${(currentRank * 100).toFixed(0)}%, volAuto=${currentVolAuto.toFixed(3)})`);
                }
                // Sell: Percentile rank of rolling average close location is greater than percentileLimit
                if (currentRank > upperLimit) {
                    return createSellSignal(cleanData, i, `Bearish Close Location Percentile Reversion (rank=${(currentRank * 100).toFixed(0)}%, volAuto=${currentVolAuto.toFixed(3)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "percentileLimit"],
    },
};
