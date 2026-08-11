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
import { computePriceActionBarMetrics } from "./price-action-frequency-core";

const OVERSHOOT_ATR = 2.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 14))),
    };
}

export const prior_bar_body_mid_reversion: Strategy = {
    name: "Prior Bar Body Mid Reversion",
    description: "Reverses closes that overshoot the prior completed bar's body midpoint by more than two ATRs.",
    defaultParams: {
        lookback: 14,
    },
    paramLabels: {
        lookback: "ATR Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);

        return createSignalLoop(cleanData, [atr], (i) => {
            const atrNow = atr[i];
            if (i < 1 || atrNow === null || atrNow <= 0) return null;

            const bodyMid = computePriceActionBarMetrics(cleanData[i - 1]).bodyMid;
            const overshoot = (closes[i] - bodyMid) / atrNow;

            if (overshoot < -OVERSHOOT_ATR) {
                return createBuySignal(cleanData, i, `Prior-body-mid buy: close ${overshoot.toFixed(2)} ATR below prior body mid`);
            }
            if (overshoot > OVERSHOOT_ATR) {
                return createSellSignal(cleanData, i, `Prior-body-mid sell: close ${overshoot.toFixed(2)} ATR above prior body mid`);
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
