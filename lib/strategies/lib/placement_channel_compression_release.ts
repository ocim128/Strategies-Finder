import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingMinMax } from "./price-action-statistics-core";

function normalizePlacementChannelCompressionReleaseParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const placement_channel_compression_release: Strategy = {
    name: "Placement Channel Compression Release",
    description: "Follows the first close-location break of a compressed prior-only placement channel as the placement regime releases.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizePlacementChannelCompressionReleaseParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePlacementChannelCompressionReleaseParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback * 2) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const channel = buildRollingMinMax(closeLocation, lookback, false);
        const channelWidth: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let i = 0; i < cleanData.length; i++) {
            if (channel.max[i] !== null && channel.min[i] !== null) {
                channelWidth[i] = channel.max[i]! - channel.min[i]!;
            }
        }
        const widthClean = channelWidth.map((v) => v ?? 0);
        const widthPct = buildPercentileRank(widthClean, lookback);

        return createSignalLoop(cleanData, [widthPct], (i) => {
            if (i < lookback * 2 - 1) return null;
            const wPct = widthPct[i];
            const priorMax = channel.max[i];
            const priorMin = channel.min[i];
            if (wPct === null || priorMax === null || priorMin === null) return null;

            if (wPct <= 0.2 && closeLocation[i] > priorMax) {
                return createBuySignal(cleanData, i, `Placement channel release: width percentile ${wPct.toFixed(2)} breaking prior max ${priorMax.toFixed(2)}`);
            }
            if (wPct <= 0.2 && closeLocation[i] < priorMin) {
                return createSellSignal(cleanData, i, `Placement channel release: width percentile ${wPct.toFixed(2)} breaking prior min ${priorMin.toFixed(2)}`);
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
