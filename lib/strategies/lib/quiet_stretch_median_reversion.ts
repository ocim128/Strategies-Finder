import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingRobustZScore } from "./price-action-statistics-core";

const STRETCH_Z_BAND = 2.0;
const QUIET_RANGE_FLOOR = 0.3;

function normalizeQuietStretchMedianReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const quiet_stretch_median_reversion: Strategy = {
    name: "Quiet Stretch Median Reversion",
    description: "Fades closes stretched beyond a robust band only when the bar's range sits quietly at a low percentile of its own history.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeQuietStretchMedianReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeQuietStretchMedianReversionParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const robustZ = buildRollingRobustZScore(closes, lookback);
        const rangePct = buildPercentileRank(buildRangeSeries(cleanData), lookback);

        return createSignalLoop(cleanData, [robustZ, rangePct], (i) => {
            if (i < lookback) return null;
            const z = robustZ[i];
            const rank = rangePct[i];
            if (z === null || rank === null) return null;

            if (z < -STRETCH_Z_BAND && rank < QUIET_RANGE_FLOOR) {
                return createBuySignal(cleanData, i, `Quiet stretch buy: robust z ${z.toFixed(2)}, range rank ${rank.toFixed(2)}`);
            }
            if (z > STRETCH_Z_BAND && rank < QUIET_RANGE_FLOOR) {
                return createSellSignal(cleanData, i, `Quiet stretch sell: robust z ${z.toFixed(2)}, range rank ${rank.toFixed(2)}`);
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
