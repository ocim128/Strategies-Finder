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
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minGradPctl: Number(params.minGradPctl ?? 0.7),
    };
}

export const vwap_gradient_momentum_divergence: Strategy = {
    name: "VWAP Gradient Momentum Divergence",
    description: "Triggers when price return diverges from the rolling VWAP trend slope, confirmed by a spike in the close location gradient percentile.",
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
        const vwapClean = vwap.map((v) => v ?? 0);
        const vwapSlope = buildRateOfChange(vwapClean, lookback);

        const returns = extractBarMetricSeries(cleanData, "closeReturn");

        const closeLoc = buildCloseLocationSeries(cleanData);
        const grad = new Array<number>(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            grad[i] = closeLoc[i] - closeLoc[i - 1];
        }
        const gradPctl = buildPercentileRank(grad, lookback);

        return createSignalLoop(cleanData, [vwapSlope, gradPctl], (i) => {
            if (i < lookback) return null;
            const currentSlope = vwapSlope[i];
            const currentGradPctl = gradPctl[i];
            if (currentSlope === null || currentGradPctl === null) return null;

            const ret = returns[i];
            const minGrad = p.minGradPctl as number;

            // Buy: VWAP slope is positive, return is negative (pullback), close location gradient percentile > minGradPctl
            if (currentSlope > 0 && ret < 0 && currentGradPctl > minGrad) {
                return createBuySignal(cleanData, i, `VWAP Mom Divergence Buy: Slope ${currentSlope.toFixed(4)}, Return ${ret.toFixed(4)}, GradPctl ${currentGradPctl.toFixed(2)}`);
            }
            // Sell: VWAP slope is negative, return is positive (pullback), close location gradient percentile < 1 - minGradPctl
            if (currentSlope < 0 && ret > 0 && currentGradPctl < (1 - minGrad)) {
                return createSellSignal(cleanData, i, `VWAP Mom Divergence Sell: Slope ${currentSlope.toFixed(4)}, Return ${ret.toFixed(4)}, GradPctl ${currentGradPctl.toFixed(2)}`);
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
