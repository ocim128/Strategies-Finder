import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getOpens } from "../strategy-helpers";
import { buildRangeSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildStreakCount, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        streakMin: Math.max(2, Math.round(Number(params.streakMin ?? 3))),
        rangePercentileMin: Math.max(0.2, Math.min(0.99, Number(params.rangePercentileMin ?? 0.50))),
    };
}

export const wick_direction_persistence_follow: Strategy = {
    name: "Wick Direction Persistence Follow",
    description: "Follows persistent wick direction streaks during meaningful range bars with close return confirmation.",
    defaultParams: {
        lookback: 30,
        streakMin: 3,
        rangePercentileMin: 0.50,
    },
    paramLabels: {
        lookback: "Lookback",
        streakMin: "Streak Min",
        rangePercentileMin: "Min Range Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const opens = getOpens(cleanData);
        const closes = getCloses(cleanData);

        // Wick direction: +1 if lower wick > upper wick (downside rejection = bullish)
        const wickDir = closes.map((c, i) => {
            const bodyHigh = Math.max(opens[i], c);
            const bodyLow = Math.min(opens[i], c);
            const upperWick = highs[i] - bodyHigh;
            const lowerWick = bodyLow - lows[i];
            if (lowerWick > upperWick) return 1;
            if (upperWick > lowerWick) return -1;
            return 0;
        });

        const streaks = buildStreakCount(wickDir);
        const ranges = buildRangeSeries(cleanData);
        const rangePctl = buildPercentileRank(ranges, lookback);
        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");

        return createSignalLoop(cleanData, [rangePctl], (i) => {
            const rp = rangePctl[i];
            if (rp === null) return null;
            if (rp < (p.rangePercentileMin as number)) return null;

            const streak = streaks[i];
            const cr = closeReturn[i];
            const streakMin = p.streakMin as number;

            // Buy: persistent lower wick dominance (downside rejection)
            if (streak >= streakMin && cr > 0) {
                return createBuySignal(cleanData, i, `Wick streak ${streak} range pctl ${rp.toFixed(2)} bullish`);
            }
            // Sell: persistent upper wick dominance (upside rejection)
            if (streak <= -streakMin && cr < 0) {
                return createSellSignal(cleanData, i, `Wick streak ${streak} range pctl ${rp.toFixed(2)} bearish`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "streakMin", "rangePercentileMin"],
    },
};
