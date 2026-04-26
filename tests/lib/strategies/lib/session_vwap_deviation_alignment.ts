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
import { calculateSessionVWAP, calculateATR } from "../indicators";

function normalizeSessionVwapDeviationAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        atr_multiplier: Math.max(0.01, Number(params.atr_multiplier ?? 0.5)),
        atr_lookback: Math.max(2, Math.round(params.atr_lookback ?? 14)),
    };
}

export const session_vwap_deviation_alignment: Strategy = {
    name: "Session VWAP Deviation Alignment",
    description: "Session VWAP is the volume-weighted fair value anchor for the current session. Close above session VWAP, normalized by ATR, means price has meaningfully disconnected above institutional value; below means disconnection below value.",
    defaultParams: {
        atr_multiplier: 0.5,
        atr_lookback: 14,
    },
    paramLabels: {
        atr_multiplier: "ATR Multiplier",
        atr_lookback: "ATR Lookback",
    },
    normalizeParams: normalizeSessionVwapDeviationAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSessionVwapDeviationAlignmentParams(params);
        if (cleanData.length < p.atr_lookback + 1) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const sessionVwap = calculateSessionVWAP(cleanData);
        const atr = calculateATR(highs, lows, closes, p.atr_lookback);

        return createSignalLoop(cleanData, [sessionVwap, atr], (i) => {
            if (i < p.atr_lookback) return null;
            const vwap = sessionVwap[i];
            const atrVal = atr[i];
            if (vwap === null || atrVal === null || atrVal <= 0) return null;

            const upperBand = vwap + p.atr_multiplier * atrVal;
            const lowerBand = vwap - p.atr_multiplier * atrVal;

            if (closes[i] > upperBand) {
                return createBuySignal(cleanData, i, `Close above session VWAP + ${p.atr_multiplier}x ATR`);
            }
            if (closes[i] < lowerBand) {
                return createSellSignal(cleanData, i, `Close below session VWAP - ${p.atr_multiplier}x ATR`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["atr_multiplier", "atr_lookback"],
    },
};
