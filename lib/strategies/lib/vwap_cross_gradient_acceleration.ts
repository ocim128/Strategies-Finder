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
import { calculateVWAP } from "../indicators";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minAcceleration: Number(params.minAcceleration ?? 0.1),
    };
}

export const vwap_cross_gradient_acceleration: Strategy = {
    name: "VWAP Cross Gradient Acceleration",
    description: "Enters on VWAP crossovers supported by accelerating close location pressure.",
    defaultParams: {
        lookback: 30,
        minAcceleration: 0.1,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minAcceleration: "Min Acceleration",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = cleanData.map((d) => d.volume);

        const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vwap, closeLoc], (i) => {
            if (i < lookback || i < 2) return null;
            const currentVwap = vwap[i];
            const prevVwap = vwap[i - 1];
            if (currentVwap === null || prevVwap === null) return null;

            const closeCurr = closes[i];
            const closePrev = closes[i - 1];

            const gradCurr = closeLoc[i] - closeLoc[i - 1];
            const gradPrev = closeLoc[i - 1] - closeLoc[i - 2];
            const accel = gradCurr - gradPrev;

            const crossAbove = closePrev <= prevVwap && closeCurr > currentVwap;
            const crossBelow = closePrev >= prevVwap && closeCurr < currentVwap;

            // Buy: Price crosses above rolling VWAP, and close location acceleration is above minAcceleration
            if (crossAbove && accel > (p.minAcceleration as number)) {
                return createBuySignal(cleanData, i, `VWAP Cross Above: Accel ${accel.toFixed(4)}`);
            }
            // Sell: Price crosses below rolling VWAP, and close location acceleration is below -minAcceleration
            if (crossBelow && accel < -(p.minAcceleration as number)) {
                return createSellSignal(cleanData, i, `VWAP Cross Below: Accel ${accel.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minAcceleration"],
    },
};
