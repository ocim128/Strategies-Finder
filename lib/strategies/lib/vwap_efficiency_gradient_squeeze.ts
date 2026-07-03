import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
} from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildRateOfChange, buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        maxEfficiency: Number(params.maxEfficiency ?? 0.4),
    };
}

export const vwap_efficiency_gradient_squeeze: Strategy = {
    name: "VWAP Efficiency Gradient Squeeze",
    description: "Detects compression where typical price efficiency of the VWAP center is low, and triggers a breakout entry when close location gradient acceleration exceeds a threshold.",
    defaultParams: {
        lookback: 30,
        maxEfficiency: 0.4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        maxEfficiency: "Max Efficiency Limit",
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

        const typical = getTypicalPrices(cleanData);
        const typicalOhlcv = cleanData.map((d, idx) => ({ ...d, close: typical[idx] }));
        const er = buildEfficiencyRatio(typicalOhlcv, lookback);

        const closeLoc = buildCloseLocationSeries(cleanData);
        const grad = new Array<number>(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            grad[i] = closeLoc[i] - closeLoc[i - 1];
        }
        const accel = buildRateOfChange(grad, lookback);

        return createSignalLoop(cleanData, [vwap, er, accel], (i) => {
            if (i < lookback) return null;
            const currentVwap = vwap[i];
            const currentEr = er[i];
            const currentAccel = accel[i];
            if (currentVwap === null || currentEr === null || currentAccel === null) return null;

            const close = closes[i];
            const maxEff = p.maxEfficiency as number;

            // Buy: efficiency < maxEfficiency, price > VWAP center, close location gradient acceleration > 0
            if (currentEr < maxEff && close > currentVwap && currentAccel > 0) {
                return createBuySignal(cleanData, i, `VWAP Squeeze Buy: ER ${currentEr.toFixed(2)}, Accel ${currentAccel.toFixed(4)}`);
            }
            // Sell: efficiency < maxEfficiency, price < VWAP center, close location gradient acceleration < 0
            if (currentEr < maxEff && close < currentVwap && currentAccel < 0) {
                return createSellSignal(cleanData, i, `VWAP Squeeze Sell: ER ${currentEr.toFixed(2)}, Accel ${currentAccel.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxEfficiency"],
    },
};
