import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRollingMedian, buildRollingMinMax } from "./price-action-statistics-core";

const ATR_PERIOD = 20;
const MIN_STRETCH_GUARD = 1.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
    };
}

export const dislocation_extreme_fade: Strategy = {
    name: "Dislocation Extreme Fade",
    description: "Fades the first bar whose median-ATR stretch becomes a new prior-only record for the lookback window.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Median & Record Window",
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

        // Dense absolute-stretch series (0 while the anchor is not valid) so
        // the min/max helper stays finite; the 1.0 guard blocks spurious
        // record flips against early zero fills.
        const absStretch: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            const a = atr[i];
            if (m !== null && a !== null && a > 0) {
                absStretch[i] = Math.abs((closes[i] - m) / a);
            }
        }
        const { max: priorMax } = buildRollingMinMax(absStretch, lookback, false);

        return createSignalLoop(cleanData, [atr, priorMax], (i) => {
            const m = median[i];
            const a = atr[i];
            const pm = priorMax[i];
            if (m === null || a === null || a <= 0 || pm === null) return null;

            const stretch = (closes[i] - m) / a;
            const absS = Math.abs(stretch);
            if (absS <= MIN_STRETCH_GUARD || absS <= pm) return null;

            if (stretch < 0) {
                return createBuySignal(cleanData, i, `New ${lookback}-bar record downside dislocation ${stretch.toFixed(2)} ATR`);
            }
            return createSellSignal(cleanData, i, `New ${lookback}-bar record upside dislocation ${stretch.toFixed(2)} ATR`);
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
