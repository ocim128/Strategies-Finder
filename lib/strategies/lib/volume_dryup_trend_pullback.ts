import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import {
    buildPercentileRank,
    buildRollingMedian,
    buildRollingRobustZScore,
} from "./price-action-statistics-core";

const TREND_MEDIAN_WINDOW = 120;
const PULLBACK_Z_DEPTH = 1;
const VOLUME_RANK_MAX = 0.2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const volume_dryup_trend_pullback: Strategy = {
    name: "Volume Dryup Trend Pullback",
    description: "Buys quiet pullbacks inside an uptrend and sells quiet rallies inside a downtrend, gated by bottom-quintile volume participation.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Pullback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < TREND_MEDIAN_WINDOW) return [];

        const closes = getCloses(cleanData);
        const robustZ = buildRollingRobustZScore(closes, lookback);
        const volumeRank = buildPercentileRank(getVolumes(cleanData), lookback);
        const trendMedian = buildRollingMedian(closes, TREND_MEDIAN_WINDOW);

        return createSignalLoop(cleanData, [robustZ, volumeRank], (i) => {
            if (i < TREND_MEDIAN_WINDOW) return null;
            const z = robustZ[i];
            const volRank = volumeRank[i];
            const trend = trendMedian[i];
            if (z === null || volRank === null || trend === null) return null;

            // Uptrend, shallow pullback, dry participation.
            if (closes[i] > trend && z <= -PULLBACK_Z_DEPTH && volRank <= VOLUME_RANK_MAX) {
                return createBuySignal(cleanData, i, `Dry pullback buy: z ${z.toFixed(2)} in uptrend, volume rank ${volRank.toFixed(2)}`);
            }
            // Downtrend, shallow rally, dry participation.
            if (closes[i] < trend && z >= PULLBACK_Z_DEPTH && volRank <= VOLUME_RANK_MAX) {
                return createSellSignal(cleanData, i, `Dry pullback sell: z ${z.toFixed(2)} in downtrend, volume rank ${volRank.toFixed(2)}`);
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
