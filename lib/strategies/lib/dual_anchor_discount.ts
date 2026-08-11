import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateATR, calculateVWAP } from "../indicators";
import { buildRollingMedian } from "./price-action-statistics-core";

const ANCHOR_DISCOUNT_ATR = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(10, Math.round(Number(params.period ?? 30))),
    };
}

export const dual_anchor_discount: Strategy = {
    name: "Dual Anchor Discount",
    description: "Fades when close sits below VWAP and at least 1.5 ATR below the rolling median, requiring both fair-price anchors to agree.",
    defaultParams: {
        period: 30,
    },
    paramLabels: {
        period: "Anchor Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.period as number;
        if (cleanData.length < period) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const vwap = calculateVWAP(highs, lows, closes, getVolumes(cleanData), period);
        const atr = calculateATR(highs, lows, closes, period);
        const median = buildRollingMedian(closes, period);

        return createSignalLoop(cleanData, [vwap, atr, median], (i) => {
            const vwapNow = vwap[i];
            const atrNow = atr[i];
            const medianNow = median[i];
            if (vwapNow === null || atrNow === null || atrNow <= 0 || medianNow === null) return null;

            const discountDown = (medianNow - closes[i]) / atrNow;
            if (closes[i] < vwapNow && discountDown >= ANCHOR_DISCOUNT_ATR) {
                return createBuySignal(cleanData, i, `Dual anchor buy: close ${discountDown.toFixed(2)} ATR below median and below VWAP`);
            }
            const discountUp = (closes[i] - medianNow) / atrNow;
            if (closes[i] > vwapNow && discountUp >= ANCHOR_DISCOUNT_ATR) {
                return createSellSignal(cleanData, i, `Dual anchor sell: close ${discountUp.toFixed(2)} ATR above median and above VWAP`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
