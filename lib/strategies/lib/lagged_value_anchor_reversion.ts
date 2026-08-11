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

const LAG_BARS = 10;
const ANCHOR_DISTANCE_ATR = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const lagged_value_anchor_reversion: Strategy = {
    name: "Lagged Value Anchor Reversion",
    description: "Fades closes stretched at least 2 ATR from where the rolling median sat 10 bars ago.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + LAG_BARS) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);

        return createSignalLoop(cleanData, [atr], (i) => {
            // The lagged anchor needs lookback warm-up bars plus the fixed lag.
            if (i < lookback + LAG_BARS) return null;
            const atrNow = atr[i];
            const anchor = median[i - LAG_BARS];
            if (atrNow === null || atrNow <= 0 || anchor === null) return null;

            const stretchDown = (anchor - closes[i]) / atrNow;
            if (stretchDown >= ANCHOR_DISTANCE_ATR) {
                return createBuySignal(cleanData, i, `Lagged anchor buy: close ${stretchDown.toFixed(2)} ATR below ${LAG_BARS}-bar-old median`);
            }
            const stretchUp = (closes[i] - anchor) / atrNow;
            if (stretchUp >= ANCHOR_DISTANCE_ATR) {
                return createSellSignal(cleanData, i, `Lagged anchor sell: close ${stretchUp.toFixed(2)} ATR above ${LAG_BARS}-bar-old median`);
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
