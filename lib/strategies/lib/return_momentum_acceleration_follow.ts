import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 24))),
    };
}

export const return_momentum_acceleration_follow: Strategy = {
    name: "Return Momentum Acceleration Follow",
    description: "Follows momentum in the direction of its own acceleration: buys accelerating uptrends and sells accelerating downtrends.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Momentum & Acceleration Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < 2 * lookback) return [];

        // Momentum of closes, then momentum of momentum (acceleration).
        const momentum = buildRateOfChange(getCloses(cleanData), lookback).map((v) => (v === null ? 0 : v));
        const acceleration = buildRateOfChange(momentum, lookback).map((v) => (v === null ? 0 : v));

        return createSignalLoop(cleanData, [acceleration], (i) => {
            const prevAcc = acceleration[i - 1];
            const currAcc = acceleration[i];
            if (prevAcc === null || currAcc === null || i < 2 * lookback) return null;

            // Momentum positive and inflecting up: the trend is still speeding up.
            if (momentum[i] > 0 && prevAcc <= 0 && currAcc > 0) {
                return createBuySignal(cleanData, i, `Momentum acceleration buy: mom ${momentum[i].toFixed(4)} accelerating (${prevAcc.toFixed(4)} -> ${currAcc.toFixed(4)})`);
            }
            if (momentum[i] < 0 && prevAcc >= 0 && currAcc < 0) {
                return createSellSignal(cleanData, i, `Momentum acceleration sell: mom ${momentum[i].toFixed(4)} accelerating (${prevAcc.toFixed(4)} -> ${currAcc.toFixed(4)})`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
