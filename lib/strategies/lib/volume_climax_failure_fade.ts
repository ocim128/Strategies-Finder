import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const CLIMAX_VOLUME_BAND = 0.9;
const PLACEMENT_MID = 0.5;

function normalizeVolumeClimaxFailureFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const volume_climax_failure_fade: Strategy = {
    name: "Volume Climax Failure Fade",
    description: "Fades extreme-volume bars that close against their own body direction, reading a failed participation climax.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeVolumeClimaxFailureFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeVolumeClimaxFailureFadeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const volumePct = buildPercentileRank(getVolumes(cleanData), lookback);
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [volumePct], (i) => {
            if (i < lookback) return null;
            const volRank = volumePct[i];
            if (volRank === null) return null;

            if (volRank > CLIMAX_VOLUME_BAND && bodyDirection[i] < 0 && closeLocation[i] > PLACEMENT_MID) {
                return createBuySignal(cleanData, i, `Volume climax fade buy: volume rank ${volRank.toFixed(2)}, bearish climax closed upper-half`);
            }
            if (volRank > CLIMAX_VOLUME_BAND && bodyDirection[i] > 0 && closeLocation[i] < PLACEMENT_MID) {
                return createSellSignal(cleanData, i, `Volume climax fade sell: volume rank ${volRank.toFixed(2)}, bullish climax closed lower-half`);
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
