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
import { buildRollingStdDev } from "./price-action-statistics-core";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        stdDevMultiplier: Number(params.stdDevMultiplier ?? 2.0),
    };
}

export const vwap_band_gradient_thrust: Strategy = {
    name: "VWAP Band Gradient Thrust",
    description: "Enters a trend breakout when price crosses beyond rolling VWAP standard deviation bands, supported by close location pressure.",
    defaultParams: {
        lookback: 30,
        stdDevMultiplier: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        stdDevMultiplier: "StdDev Multiplier",
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

        const diffSeries = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const v = vwap[i];
            diffSeries[i] = v !== null ? closes[i] - v : 0;
        }

        const diffStdDev = buildRollingStdDev(diffSeries, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vwap, diffStdDev, closeLoc], (i) => {
            if (i < lookback || i < 1) return null;
            const currentVwap = vwap[i];
            const prevVwap = vwap[i - 1];
            const currentStd = diffStdDev[i];
            const prevStd = diffStdDev[i - 1];
            if (currentVwap === null || prevVwap === null || currentStd === null || prevStd === null) return null;

            const closeCurr = closes[i];
            const closePrev = closes[i - 1];
            const currGrad = closeLoc[i] - closeLoc[i - 1];

            const mult = p.stdDevMultiplier as number;
            const prevUpper = prevVwap + mult * prevStd;
            const currUpper = currentVwap + mult * currentStd;
            const crossAbove = closePrev <= prevUpper && closeCurr > currUpper;

            const prevLower = prevVwap - mult * prevStd;
            const currLower = currentVwap - mult * currentStd;
            const crossBelow = closePrev >= prevLower && closeCurr < currLower;

            // Buy: price crosses above upper band, close location gradient is positive
            if (crossAbove && currGrad > 0) {
                return createBuySignal(cleanData, i, `VWAP Band Thrust Buy: Close ${closeCurr.toFixed(4)}, Band ${currUpper.toFixed(4)}`);
            }
            // Sell: price crosses below lower band, close location gradient is negative
            if (crossBelow && currGrad < 0) {
                return createSellSignal(cleanData, i, `VWAP Band Thrust Sell: Close ${closeCurr.toFixed(4)}, Band ${currLower.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "stdDevMultiplier"],
    },
};
