import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

const RANGE_RANK_MIN = 0.95;
const VOLUME_Z_MIN = 2;
const CLOSE_EXTREME = 0.2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(20, Math.round(Number(params.lookback ?? 60))),
    };
}

export const climax_exhaustion_reversal: Strategy = {
    name: "Climax Exhaustion Reversal",
    description: "Fades extreme-range, extreme-volume bars that close pinned at their own extreme, matching the exhaustion climax signature.",
    defaultParams: {
        lookback: 60,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const rangeRank = buildPercentileRank(buildRangeSeries(cleanData), lookback);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [rangeRank, volumeZ], (i) => {
            const rank = rangeRank[i];
            const volZ = volumeZ[i];
            if (rank === null || volZ === null) return null;

            // Downward selling climax: close pinned at the low of an extreme bar.
            if (rank >= RANGE_RANK_MIN && volZ >= VOLUME_Z_MIN && closeLocation[i] <= CLOSE_EXTREME) {
                return createBuySignal(cleanData, i, `Climax buy: range rank ${rank.toFixed(2)}, volume z ${volZ.toFixed(2)}, close location ${closeLocation[i].toFixed(2)}`);
            }
            // Upward buying climax: close pinned at the high of an extreme bar.
            if (rank >= RANGE_RANK_MIN && volZ >= VOLUME_Z_MIN && closeLocation[i] >= 1 - CLOSE_EXTREME) {
                return createSellSignal(cleanData, i, `Climax sell: range rank ${rank.toFixed(2)}, volume z ${volZ.toFixed(2)}, close location ${closeLocation[i].toFixed(2)}`);
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
