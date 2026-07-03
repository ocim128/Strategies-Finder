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
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minEfficiency: Number(params.minEfficiency ?? 0.6),
    };
}

export const vwap_drift_gradient_efficiency: Strategy = {
    name: "VWAP Drift Gradient Efficiency",
    description: "Follows structural trends away from the VWAP center only if the move is efficient and close location gradient agrees.",
    defaultParams: {
        lookback: 30,
        minEfficiency: 0.6,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minEfficiency: "Min Efficiency",
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
        const er = buildEfficiencyRatio(cleanData, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vwap, er, closeLoc], (i) => {
            if (i < lookback || i < 1) return null;
            const currentVwap = vwap[i];
            const currentEr = er[i];
            if (currentVwap === null || currentEr === null) return null;

            const close = closes[i];
            const currGrad = closeLoc[i] - closeLoc[i - 1];

            // Buy: price is above VWAP, efficiency is above minEfficiency, close location gradient positive
            if (close > currentVwap && currentEr > (p.minEfficiency as number) && currGrad > 0) {
                return createBuySignal(cleanData, i, `VWAP Drift Eff Buy: Close ${close.toFixed(4)}, VWAP ${currentVwap.toFixed(4)}, ER ${currentEr.toFixed(2)}`);
            }
            // Sell: price is below VWAP, efficiency is above minEfficiency, close location gradient negative
            if (close < currentVwap && currentEr > (p.minEfficiency as number) && currGrad < 0) {
                return createSellSignal(cleanData, i, `VWAP Drift Eff Sell: Close ${close.toFixed(4)}, VWAP ${currentVwap.toFixed(4)}, ER ${currentEr.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEfficiency"],
    },
};
