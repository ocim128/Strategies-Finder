import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const GAP_BAND_LOW = 0.7;
const GAP_BAND_HIGH = 0.95;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(15, Math.round(Number(params.lookback ?? 40))),
    };
}

export const moderate_gap_reversion: Strategy = {
    name: "Moderate Gap Reversion",
    description: "Fades moderate gaps (70th-95th percentile of absolute gap) that fill back through the prior close within the bar.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Gap Percentile Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const gapRank = buildPercentileRank(gapPct.map((g) => Math.abs(g)), lookback);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [gapRank], (i) => {
            const rank = gapRank[i];
            if (rank === null || i < 1) return null;

            const inBand = rank >= GAP_BAND_LOW && rank <= GAP_BAND_HIGH;
            if (!inBand) return null;
            const gap = gapPct[i];

            // Down gap that fills back above the prior close during the same bar.
            if (gap < 0 && cleanData[i].close > cleanData[i].open && closes[i] > closes[i - 1]) {
                return createBuySignal(cleanData, i, `Gap fill buy: ${(gap * 100).toFixed(2)}% gap (rank ${rank.toFixed(2)}) filled`);
            }
            // Up gap that fills back below the prior close during the same bar.
            if (gap > 0 && cleanData[i].close < cleanData[i].open && closes[i] < closes[i - 1]) {
                return createSellSignal(cleanData, i, `Gap fill sell: ${(gap * 100).toFixed(2)}% gap (rank ${rank.toFixed(2)}) filled`);
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
