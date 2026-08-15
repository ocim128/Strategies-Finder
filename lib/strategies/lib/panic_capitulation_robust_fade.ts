import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingRobustZScore } from "./price-action-statistics-core";

const PRICE_Z_EXTREME = 2.0;
const VOLUME_Z_ELEVATED = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const panic_capitulation_robust_fade: Strategy = {
    name: "Panic Capitulation Robust Fade",
    description: "Fades co-extreme robust z-scores of closes and the volume proxy as participation-confirmed exhaustion.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const priceZ = buildRollingRobustZScore(getCloses(cleanData), lookback);
        const volumeZ = buildRollingRobustZScore(getVolumes(cleanData), lookback);

        return createSignalLoop(cleanData, [priceZ, volumeZ], (i) => {
            const priceScore = priceZ[i];
            const volumeScore = volumeZ[i];
            if (priceScore === null || volumeScore === null) return null;
            if (volumeScore < VOLUME_Z_ELEVATED) return null;

            if (priceScore <= -PRICE_Z_EXTREME) {
                return createBuySignal(cleanData, i, `Capitulation fade: price z ${priceScore.toFixed(2)}, volume z ${volumeScore.toFixed(2)}`);
            }
            if (priceScore >= PRICE_Z_EXTREME) {
                return createSellSignal(cleanData, i, `Euphoria fade: price z ${priceScore.toFixed(2)}, volume z ${volumeScore.toFixed(2)}`);
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
