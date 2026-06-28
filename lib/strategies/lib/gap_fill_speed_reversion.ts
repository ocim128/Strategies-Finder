import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        gapPercentileMin: Math.max(0.3, Math.min(0.99, Number(params.gapPercentileMin ?? 0.60))),
    };
}

export const gap_fill_speed_reversion: Strategy = {
    name: "Gap Fill Speed Reversion",
    description: "Follows the fill direction when significant gaps fill within the same bar, indicating market efficiency.",
    defaultParams: {
        lookback: 30,
        gapPercentileMin: 0.60,
    },
    paramLabels: {
        lookback: "Lookback",
        gapPercentileMin: "Min Gap Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const absGap = gapPct.map(v => Math.abs(v));
        const gapPctl = buildPercentileRank(absGap, lookback);
        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");

        return createSignalLoop(cleanData, [gapPctl], (i) => {
            const gp = gapPctl[i];
            if (gp === null) return null;
            if (gp < (p.gapPercentileMin as number)) return null;

            const gap = gapPct[i];
            const cr = closeReturn[i];

            // Buy: gapped down, filled upward
            if (gap < 0 && cr > 0) {
                return createBuySignal(cleanData, i, `Gap fill gap ${(gap * 100).toFixed(2)}% pctl ${gp.toFixed(2)} filled up`);
            }
            // Sell: gapped up, filled downward
            if (gap > 0 && cr < 0) {
                return createSellSignal(cleanData, i, `Gap fill gap ${(gap * 100).toFixed(2)}% pctl ${gp.toFixed(2)} filled down`);
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
