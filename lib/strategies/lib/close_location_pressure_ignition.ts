import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildStreakCount, buildRateOfChange, buildRollingStdDev, buildPercentileRank, buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        streakMin: Math.max(2, Math.round(Number(params.streakMin ?? 3))),
        volPercentileMax: Math.max(0.1, Math.min(0.9, Number(params.volPercentileMax ?? 0.35))),
    };
}

export const close_location_pressure_ignition: Strategy = {
    name: "Close Location Pressure Ignition",
    description: "Ignites directional trades when persistent close-location pressure breaks out of tight volatility coupling with efficiency confirmation.",
    defaultParams: {
        lookback: 30,
        streakMin: 3,
        volPercentileMax: 0.35,
    },
    paramLabels: {
        lookback: "Lookback",
        streakMin: "Streak Min",
        volPercentileMax: "Max Vol Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const closeLocation = buildCloseLocationSeries(cleanData);

        // Close location directional flags: >0.5 = bullish, <0.5 = bearish
        const clFlags = closeLocation.map(v => v > 0.5 ? 1 : v < 0.5 ? -1 : 0);
        const streaks = buildStreakCount(clFlags);

        // Return volatility
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const volStdDev = buildRollingStdDev(returnsClean, lookback);
        const volPctl = buildPercentileRank(volStdDev.map(v => v ?? 0), lookback);

        // Efficiency ratio for directional conviction
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [volPctl, efficiency], (i) => {
            if (i < lookback + 1) return null;
            const vp = volPctl[i];
            const er = efficiency[i];
            const streak = streaks[i];
            if (vp === null || er === null) return null;

            const streakMin = p.streakMin as number;
            const volMax = p.volPercentileMax as number;

            // Buy: bullish streak + compression + efficiency break
            if (streak >= streakMin && vp < volMax && er > 0.50) {
                return createBuySignal(cleanData, i, `CL pressure streak ${streak} vol pctl ${vp.toFixed(2)} eff ${er.toFixed(2)}`);
            }
            // Sell: bearish streak + compression + efficiency break
            if (streak <= -streakMin && vp < volMax && er > 0.50) {
                return createSellSignal(cleanData, i, `CL pressure streak ${streak} vol pctl ${vp.toFixed(2)} eff ${er.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "streakMin", "volPercentileMax"],
    },
};
