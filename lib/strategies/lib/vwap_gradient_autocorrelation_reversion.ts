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
import { buildRollingStdDev, buildRollingAutoCorrelation } from "./price-action-statistics-core";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minAutoCorr: Number(params.minAutoCorr ?? -0.2),
    };
}

export const vwap_gradient_autocorrelation_reversion: Strategy = {
    name: "VWAP Gradient Autocorrelation Reversion",
    description: "Fades price deviations from the VWAP center during mean-reverting regimes when close location gradient reverses.",
    defaultParams: {
        lookback: 30,
        minAutoCorr: -0.2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minAutoCorr: "Max Autocorrelation",
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
        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const ac = buildRollingAutoCorrelation(returns, lookback, 1);

        const diffSeries = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const v = vwap[i];
            diffSeries[i] = v !== null ? closes[i] - v : 0;
        }
        const std = buildRollingStdDev(diffSeries, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vwap, ac, std, closeLoc], (i) => {
            if (i < lookback || i < 1) return null;
            const currentVwap = vwap[i];
            const currentAc = ac[i];
            const currentStd = std[i];
            if (currentVwap === null || currentAc === null || currentStd === null) return null;

            const close = closes[i];
            const currGrad = closeLoc[i] - closeLoc[i - 1];
            const limit = p.minAutoCorr as number;

            // Buy: price is below VWAP by 1.5 StdDev, AC < minAutoCorr, close location gradient positive
            if (close < currentVwap - 1.5 * currentStd && currentAc < limit && currGrad > 0) {
                return createBuySignal(cleanData, i, `VWAP Grad MR Buy: AC ${currentAc.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
            }
            // Sell: price is above VWAP by 1.5 StdDev, AC < minAutoCorr, close location gradient negative
            if (close > currentVwap + 1.5 * currentStd && currentAc < limit && currGrad < 0) {
                return createSellSignal(cleanData, i, `VWAP Grad MR Sell: AC ${currentAc.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minAutoCorr"],
    },
};
