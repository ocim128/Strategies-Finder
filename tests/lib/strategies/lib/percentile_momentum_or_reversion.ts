import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

function normalizePercentileMomentumOrReversionParams(params: StrategyParams): StrategyParams {
    const shortWindow = Math.max(2, Math.round(Number(params.short_window ?? 20)));
    const longWindow = Math.max(shortWindow + 1, Math.round(Number(params.long_window ?? 126)));
    return {
        ...params,
        short_window: shortWindow,
        long_window: longWindow,
    };
}

export const percentile_momentum_or_reversion: Strategy = {
    name: "Percentile Momentum Or Reversion",
    description:
        "Combines short-horizon percentile momentum with long-horizon percentile pullback and bounce branches.",
    defaultParams: {
        short_window: 20,
        long_window: 126,
    },
    paramLabels: {
        short_window: "Short Window",
        long_window: "Long Window",
    },
    normalizeParams: normalizePercentileMomentumOrReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePercentileMomentumOrReversionParams(params);
        const shortWindow = p.short_window as number;
        const longWindow = p.long_window as number;
        if (cleanData.length < longWindow + 1) return [];

        const closes = getCloses(cleanData);
        const shortRank = buildPercentileRank(closes, shortWindow);
        const longRank = buildPercentileRank(closes, longWindow);
        const shortMedian = buildRollingMedian(closes, shortWindow);

        return createSignalLoop(cleanData, [shortRank, longRank, shortMedian], (i) => {
            if (i < longWindow) return null;

            const shortPercentile = shortRank[i];
            const priorShortPercentile = shortRank[i - 1];
            const longPercentile = longRank[i];
            const median = shortMedian[i];
            if (shortPercentile === null || priorShortPercentile === null || longPercentile === null || median === null) return null;

            const momentumLong = shortPercentile > priorShortPercentile && closes[i] > median;
            const momentumShort = shortPercentile < priorShortPercentile && closes[i] < median;
            const reversionLong = longPercentile > 0.8 && closes[i] < closes[i - 1];
            const reversionShort = longPercentile < 0.2 && closes[i] > closes[i - 1];

            const longSignal = momentumLong || reversionLong;
            const shortSignal = momentumShort || reversionShort;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, `Percentile composite long short=${shortPercentile.toFixed(2)} long=${longPercentile.toFixed(2)}`);
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, `Percentile composite short short=${shortPercentile.toFixed(2)} long=${longPercentile.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["short_window", "long_window"],
    },
};
