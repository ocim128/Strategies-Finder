import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

const ATR_PERIOD = 20;
const STRETCH_FADE_PCT = 0.05;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 40))),
    };
}

export const stretch_percentile_fade: Strategy = {
    name: "Stretch Percentile Fade",
    description: "Fades closes whose median-ATR stretch ranks in the bottom 5% or top 5% of its own history.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Median & Percentile Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, ATR_PERIOD);

        // Mask warm-up nulls as NaN so the percentile window fills only with
        // real stretch values; the rank then includes the current bar.
        const stretchMasked: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            const a = atr[i];
            stretchMasked[i] = m !== null && a !== null && a > 0 ? (closes[i] - m) / a : Number.NaN;
        }
        const pct = buildPercentileRank(stretchMasked, lookback);

        // All gates read the current bar's percentile, so the current-bar loop
        // avoids the one-bar delay the standard loop adds for i-1 comparisons.
        return createCurrentBarSignalLoop(cleanData, [atr, pct], (i) => {
            const m = median[i];
            const a = atr[i];
            const r = pct[i];
            if (m === null || a === null || a <= 0 || r === null) return null;

            if (r <= STRETCH_FADE_PCT) {
                const stretch = (closes[i] - m) / a;
                return createBuySignal(cleanData, i, `Stretch percentile ${r.toFixed(2)} (${stretch.toFixed(2)} ATR) extreme low`);
            }
            if (r >= 1 - STRETCH_FADE_PCT) {
                const stretch = (closes[i] - m) / a;
                return createSellSignal(cleanData, i, `Stretch percentile ${r.toFixed(2)} (${stretch.toFixed(2)} ATR) extreme high`);
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
