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
import { buildPercentileRank } from "./price-action-statistics-core";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minGradPctl: Number(params.minGradPctl ?? 0.7),
    };
}

export const vwap_crossover_gradient_acceleration: Strategy = {
    name: "VWAP Crossover Gradient Acceleration",
    description: "Crossover of the rolling VWAP center confirmed by elevated close location gradient percentile rank.",
    defaultParams: {
        lookback: 30,
        minGradPctl: 0.7,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minGradPctl: "Min Gradient Percentile",
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

        const grad = new Array<number>(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            grad[i] = closeLoc[i] - closeLoc[i - 1];
        }

        const gradPctl = buildPercentileRank(grad, lookback);

        return createSignalLoop(cleanData, [vwap, gradPctl], (i) => {
            if (i < lookback || i < 1) return null;
            const currentVwap = vwap[i];
            const prevVwap = vwap[i - 1];
            const currentGradPctl = gradPctl[i];
            if (currentVwap === null || prevVwap === null || currentGradPctl === null) return null;

            const closeCurr = closes[i];
            const closePrev = closes[i - 1];

            const crossAbove = closePrev <= prevVwap && closeCurr > currentVwap;
            const crossBelow = closePrev >= prevVwap && closeCurr < currentVwap;

            const minGrad = p.minGradPctl as number;

            // Buy: price crosses above VWAP, gradient percentile > minGradPctl
            if (crossAbove && currentGradPctl > minGrad) {
                return createBuySignal(cleanData, i, `VWAP Cross Above Accel: GradPctl ${currentGradPctl.toFixed(2)}`);
            }
            // Sell: price crosses below VWAP, gradient percentile < 1 - minGradPctl
            if (crossBelow && currentGradPctl < (1 - minGrad)) {
                return createSellSignal(cleanData, i, `VWAP Cross Below Accel: GradPctl ${currentGradPctl.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minGradPctl"],
    },
};
