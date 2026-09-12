import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingStdDev } from "./price-action-statistics-core";

const FAST_AVERAGE_BARS = 5;
const Z_SCORE_FADE = 1.2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(6, Math.round(Number(params.lookback ?? 20))),
    };
}

export const short_term_overextension_fade: Strategy = {
    name: "Short Term Overextension Fade",
    description: "Fades 5-bar average moves more than 1.2 standard deviations from the rolling average, reverting short-term overshoot of the medium-term center.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Slow Average Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < 2 * lookback - 1) return [];

        const closes = getCloses(cleanData);
        const fastAvg = buildRollingAverage(closes, FAST_AVERAGE_BARS);
        const slowAvg = buildRollingAverage(closes, lookback);

        const diff: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const fast = fastAvg[i];
            const slow = slowAvg[i];
            if (fast !== null && slow !== null) {
                diff[i] = fast - slow;
            }
        }
        const std = buildRollingStdDev(diff, lookback);

        return createSignalLoop(cleanData, [std], (i) => {
            // Wait until the trailing std window holds only fully-valid average diffs.
            if (i < 2 * lookback - 2) return null;
            const s = std[i];
            const fast = fastAvg[i];
            const slow = slowAvg[i];
            if (s === null || fast === null || slow === null) return null;

            const z = diff[i] / Math.max(s, 1e-10);

            if (z < -Z_SCORE_FADE) {
                return createBuySignal(cleanData, i, `Fast/slow average z-score ${z.toFixed(2)} oversold fade`);
            }
            if (z > Z_SCORE_FADE) {
                return createSellSignal(cleanData, i, `Fast/slow average z-score ${z.toFixed(2)} overbought fade`);
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
