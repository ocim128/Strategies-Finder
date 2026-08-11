import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const PARTICIPATION_LEVEL = 0.8;
const COMPRESSION_LEVEL = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const participation_squeeze_divergence: Strategy = {
    name: "Participation Squeeze Divergence",
    description: "Follows bars with top participation but compressed range: one side absorbs without price conceding, and the close picks the side.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Participation & Compression Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const volumeRank = buildPercentileRank(getVolumes(cleanData), lookback);
        const rangeRank = buildPercentileRank(buildRangeSeries(cleanData), lookback);

        return createSignalLoop(cleanData, [volumeRank, rangeRank], (i) => {
            const vol = volumeRank[i];
            const rng = rangeRank[i];
            if (vol === null || rng === null) return null;

            // High participation on a compressed bar: absorption, resolved up or down.
            if (vol >= PARTICIPATION_LEVEL && rng <= COMPRESSION_LEVEL && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Participation squeeze buy: vol rank ${vol.toFixed(2)} on range rank ${rng.toFixed(2)}`);
            }
            if (vol >= PARTICIPATION_LEVEL && rng <= COMPRESSION_LEVEL && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Participation squeeze sell: vol rank ${vol.toFixed(2)} on range rank ${rng.toFixed(2)}`);
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
