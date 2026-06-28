import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeSimpleGapFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        gapPercentileMin: Math.max(0, Math.min(1, Number(params.gapPercentileMin ?? 0.80))),
    };
}

export const simple_gap_fade: Strategy = {
    name: "Simple Gap Fade",
    description: "Session gap mean reversion without quality gates.",
    defaultParams: {
        lookback: 30,
        gapPercentileMin: 0.80,
    },
    paramLabels: {
        lookback: "Lookback",
        gapPercentileMin: "Gap Percentile Min",
    },
    normalizeParams: normalizeSimpleGapFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSimpleGapFadeParams(params);
        const lookback = p.lookback as number;
        const gapPercentileMin = p.gapPercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const absGapPct = gapPct.map(Math.abs);
        const gapPercentile = buildPercentileRank(absGapPct, lookback);

        return createSignalLoop(cleanData, [gapPercentile, gapPct], (i) => {
            const gapPctRank = gapPercentile[i];
            const gap = gapPct[i];
            if (gapPctRank === null || gap === null) return null;

            if (gapPctRank > gapPercentileMin && gap < 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Gap down of ${gap.toFixed(4)} at percentile ${gapPctRank.toFixed(2)}`
                );
            }
            if (gapPctRank > gapPercentileMin && gap > 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Gap up of ${gap.toFixed(4)} at percentile ${gapPctRank.toFixed(2)}`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "gapPercentileMin"],
    },
};
