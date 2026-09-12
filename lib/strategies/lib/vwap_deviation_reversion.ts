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

const DEVIATION_BAND = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(5, Math.round(Number(params.period ?? 30))),
    };
}

export const vwap_deviation_reversion: Strategy = {
    name: "VWAP Deviation Reversion",
    description: "Fades multi-ATR excursions from the rolling participation-weighted VWAP anchor.",
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
        const vwap = calculateVWAP(getHighs(cleanData), getLows(cleanData), closes, getVolumes(cleanData), period);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, period);

        return createSignalLoop(cleanData, [vwap, atr], (i) => {
            const vwapNow = vwap[i];
            const atrNow = atr[i];
            if (vwapNow === null || atrNow === null || atrNow <= 0) return null;

            const deviation = (closes[i] - vwapNow) / atrNow;
            if (deviation <= -DEVIATION_BAND) {
                return createBuySignal(cleanData, i, `VWAP deviation buy: close ${deviation.toFixed(2)} ATR below VWAP`);
            }
            if (deviation >= DEVIATION_BAND) {
                return createSellSignal(cleanData, i, `VWAP deviation sell: close ${deviation.toFixed(2)} ATR above VWAP`);
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
