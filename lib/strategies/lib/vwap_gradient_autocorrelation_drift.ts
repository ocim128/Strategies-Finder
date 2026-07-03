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
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minAutoCorr: Number(params.minAutoCorr ?? 0.2),
    };
}

export const vwap_gradient_autocorrelation_drift: Strategy = {
    name: "VWAP Gradient Autocorrelation Drift",
    description: "Trades trends away from the VWAP center only when returns show serial persistence and close location gradient is positive/negative.",
    defaultParams: {
        lookback: 30,
        minAutoCorr: 0.2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minAutoCorr: "Min Autocorrelation",
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
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vwap, ac, closeLoc], (i) => {
            if (i < lookback || i < 1) return null;
            const currentVwap = vwap[i];
            const currentAc = ac[i];
            if (currentVwap === null || currentAc === null) return null;

            const close = closes[i];
            const currGrad = closeLoc[i] - closeLoc[i - 1];

            const minAc = p.minAutoCorr as number;

            // Buy: price above VWAP, autocorrelation > minAutoCorr, close location gradient positive
            if (close > currentVwap && currentAc > minAc && currGrad > 0) {
                return createBuySignal(cleanData, i, `VWAP Grad Drift Buy: AC ${currentAc.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
            }
            // Sell: price below VWAP, autocorrelation > minAutoCorr, close location gradient negative
            if (close < currentVwap && currentAc > minAc && currGrad < 0) {
                return createSellSignal(cleanData, i, `VWAP Grad Drift Sell: AC ${currentAc.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
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
