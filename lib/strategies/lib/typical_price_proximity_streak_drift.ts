import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes, getTypicalPrices } from "../strategy-helpers";
import { buildStreakCount, buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        streakMin: Math.max(2, Math.round(Number(params.streakMin ?? 3))),
        volumePercentileMin: Math.max(0.1, Math.min(0.95, Number(params.volumePercentileMin ?? 0.40))),
    };
}

export const typical_price_proximity_streak_drift: Strategy = {
    name: "Typical Price Proximity Streak Drift",
    description: "Follows persistent directional drift when close stays above/below typical price with momentum and proxy volume confirmation.",
    defaultParams: {
        lookback: 30,
        streakMin: 3,
        volumePercentileMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        streakMin: "Streak Min",
        volumePercentileMin: "Min Volume Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const typicalPrices = getTypicalPrices(cleanData);
        const volumes = getVolumes(cleanData);

        // Directional flags: close vs typical price
        const flags = closes.map((c, i) => c > typicalPrices[i] ? 1 : c < typicalPrices[i] ? -1 : 0);
        const streaks = buildStreakCount(flags);

        // Proxy volume percentile
        const volPctl = buildPercentileRank(volumes, lookback);

        // 1-bar momentum
        const momentum = buildRateOfChange(closes, 1);

        return createSignalLoop(cleanData, [volPctl, momentum], (i) => {
            if (i < lookback) return null;
            const vp = volPctl[i];
            const mom = momentum[i];
            const streak = streaks[i];
            if (vp === null || mom === null) return null;

            const streakMin = p.streakMin as number;

            if (streak >= streakMin && mom > 0 && vp >= (p.volumePercentileMin as number)) {
                return createBuySignal(cleanData, i, `Typical price streak ${streak} mom ${(mom * 100).toFixed(3)}% vol pctl ${vp.toFixed(2)}`);
            }
            if (streak <= -streakMin && mom < 0 && vp >= (p.volumePercentileMin as number)) {
                return createSellSignal(cleanData, i, `Typical price streak ${streak} mom ${(mom * 100).toFixed(3)}% vol pctl ${vp.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "streakMin", "volumePercentileMin"],
    },
};
