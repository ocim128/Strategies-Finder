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

export const vwap_deviation_gradient_fade: Strategy = {
    name: "VWAP Deviation Gradient Fade",
    description: "Fades extreme deviations from the rolling VWAP center when close location gradient reverses.",
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
            if (i < lookback || i < 2) return null;
            const currentVwap = vwap[i];
            const currentStd = diffStdDev[i];
            if (currentVwap === null || currentStd === null) return null;

            const close = closes[i];
            const prevGrad = closeLoc[i - 1] - closeLoc[i - 2];
            const currGrad = closeLoc[i] - closeLoc[i - 1];

            const mult = p.stdDevMultiplier as number;
            const belowBand = close < currentVwap - mult * currentStd;
            const aboveBand = close > currentVwap + mult * currentStd;

            // Buy: Price below band, close location gradient reverses to positive
            if (belowBand && currGrad > 0 && prevGrad <= 0) {
                return createBuySignal(cleanData, i, `VWAP Dev Fade Buy: Close ${close.toFixed(4)}, Band ${(currentVwap - mult * currentStd).toFixed(4)}, Grad ${currGrad.toFixed(4)}`);
            }
            // Sell: Price above band, close location gradient reverses to negative
            if (aboveBand && currGrad < 0 && prevGrad >= 0) {
                return createSellSignal(cleanData, i, `VWAP Dev Fade Sell: Close ${close.toFixed(4)}, Band ${(currentVwap + mult * currentStd).toFixed(4)}, Grad ${currGrad.toFixed(4)}`);
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
