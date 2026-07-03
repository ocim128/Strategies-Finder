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

export const failed_vwap_gradient_exhaustion: Strategy = {
    name: "Failed VWAP Gradient Exhaustion",
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
            if (i < lookback || i < 1) return null;
            const currentVwap = vwap[i];
            const currentStd = diffStdDev[i];
            if (currentVwap === null || currentStd === null) return null;

            const close = closes[i];
            const currGrad = closeLoc[i] - closeLoc[i - 1];

            const mult = p.stdDevMultiplier as number;
            const belowBand = close < currentVwap - mult * currentStd;
            const aboveBand = close > currentVwap + mult * currentStd;

            // Buy: price below lower band, close location gradient positive
            if (belowBand && currGrad > 0) {
                return createBuySignal(cleanData, i, `Failed VWAP Exh Buy: Close ${close.toFixed(4)}, Band ${(currentVwap - mult * currentStd).toFixed(4)}, Grad ${currGrad.toFixed(4)}`);
            }
            // Sell: price above upper band, close location gradient negative
            if (aboveBand && currGrad < 0) {
                return createSellSignal(cleanData, i, `Failed VWAP Exh Sell: Close ${close.toFixed(4)}, Band ${(currentVwap + mult * currentStd).toFixed(4)}, Grad ${currGrad.toFixed(4)}`);
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
