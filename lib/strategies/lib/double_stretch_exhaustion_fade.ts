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
import { buildRollingMedian } from "./price-action-statistics-core";

const ATR_PERIOD = 20;
const STRETCH_BAND = 1.2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
    };
}

export const double_stretch_exhaustion_fade: Strategy = {
    name: "Double Stretch Exhaustion Fade",
    description: "Fades the second consecutive bar stretched at least 1.2 ATR from the rolling median.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Median Anchor Window",
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

        return createSignalLoop(cleanData, [atr], (i) => {
            if (i < 1) return null;
            const m = median[i];
            const mPrev = median[i - 1];
            const a = atr[i];
            const aPrev = atr[i - 1];
            if (m === null || mPrev === null || a === null || aPrev === null || a <= 0 || aPrev <= 0) return null;

            const s = (closes[i] - m) / a;
            const sPrev = (closes[i - 1] - mPrev) / aPrev;

            if (s <= -STRETCH_BAND && sPrev <= -STRETCH_BAND) {
                return createBuySignal(cleanData, i, `Second consecutive downside stretch ${s.toFixed(2)} / ${sPrev.toFixed(2)} ATR`);
            }
            if (s >= STRETCH_BAND && sPrev >= STRETCH_BAND) {
                return createSellSignal(cleanData, i, `Second consecutive upside stretch ${s.toFixed(2)} / ${sPrev.toFixed(2)} ATR`);
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
