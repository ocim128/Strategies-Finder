import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

const GAP_PERCENTILE_GATE = 0.9;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const gap_percentile_fade: Strategy = {
    name: "Gap Percentile Fade",
    description: "Fades reopen gaps whose |gap| sits at a percentile extreme of its own history.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Percentile Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const gaps = extractBarMetricSeries(cleanData, "gapPct");
        const absGaps = gaps.map((v) => Math.abs(v));
        const pct = buildPercentileRank(absGaps, lookback);

        return createSignalLoop(cleanData, [pct], (i) => {
            const pr = pct[i];
            if (pr === null || pr < GAP_PERCENTILE_GATE) return null;

            // Fade the direction of an extreme gap: an extreme down gap fades up.
            if (gaps[i] < 0) {
                return createBuySignal(cleanData, i, `Extreme down gap fades up: rank ${pr.toFixed(2)}`);
            }
            if (gaps[i] > 0) {
                return createSellSignal(cleanData, i, `Extreme up gap fades down: rank ${pr.toFixed(2)}`);
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
