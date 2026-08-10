import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeGapAbsorptionReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        gapLookback: Math.max(2, Math.round(Number(params.gapLookback ?? 30))),
    };
}

export const gap_absorption_reversion: Strategy = {
    name: "Gap Absorption Reversion",
    description: "Fades extreme percentile gaps that are reclaimed back inside the prior bar's range on the same bar.",
    defaultParams: {
        gapLookback: 30,
    },
    paramLabels: {
        gapLookback: "Gap Percentile Lookback",
    },
    normalizeParams: normalizeGapAbsorptionReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeGapAbsorptionReversionParams(params);
        const gapLookback = p.gapLookback as number;
        if (cleanData.length < gapLookback + 1) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const absGap = gapPct.map((v) => Math.abs(v));
        const gapRank = buildPercentileRank(absGap, gapLookback);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        return createSignalLoop(cleanData, [gapRank], (i) => {
            if (i < gapLookback) return null;
            const rank = gapRank[i];
            if (rank === null) return null;

            if (gapPct[i] < 0 && rank > 0.8 && cleanData[i].close > lows[i - 1]) {
                return createBuySignal(cleanData, i, `Extreme down gap (${(gapPct[i] * 100).toFixed(2)}%) absorbed back inside prior range (rank ${rank.toFixed(2)})`);
            }
            if (gapPct[i] > 0 && rank > 0.8 && cleanData[i].close < highs[i - 1]) {
                return createSellSignal(cleanData, i, `Extreme up gap (${(gapPct[i] * 100).toFixed(2)}%) rejected back inside prior range (rank ${rank.toFixed(2)})`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["gapLookback"],
    },
};
