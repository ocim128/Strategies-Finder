import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

const PARTICIPATION_LEVEL = 0.8;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const volume_confirmed_trend_follow: Strategy = {
    name: "Volume Confirmed Trend Follow",
    description: "Follows trend-side bars confirmed by a top-quintile percentile of relative volume.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Participation & Trend Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const volumeRank = buildPercentileRank(getVolumes(cleanData), lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [volumeRank, median], (i) => {
            const rank = volumeRank[i];
            const med = median[i];
            if (rank === null || med === null) return null;

            // Funded move: top participation percentile AND trend-side bar.
            if (rank >= PARTICIPATION_LEVEL && closes[i] > cleanData[i].open && closes[i] > med) {
                return createBuySignal(cleanData, i, `Volume-confirmed buy: vol rank ${rank.toFixed(2)} up bar above median`);
            }
            if (rank >= PARTICIPATION_LEVEL && closes[i] < cleanData[i].open && closes[i] < med) {
                return createSellSignal(cleanData, i, `Volume-confirmed sell: vol rank ${rank.toFixed(2)} down bar below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
