import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingMinMax } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(8, Math.round(Number(params.lookback ?? 24))),
    };
}

export const typical_price_envelope_breakout: Strategy = {
    name: "Typical Price Envelope Breakout",
    description: "Follows breakouts of the prior-only typical-price envelope, confirmed by the bar's own direction.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Envelope Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const typical = getTypicalPrices(cleanData);
        const { min, max } = buildRollingMinMax(typical, lookback, false);

        return createSignalLoop(cleanData, [min, max], (i) => {
            const lo = min[i];
            const hi = max[i];
            if (lo === null || hi === null) return null;

            // Typical price clears the prior-only envelope in the bar's direction.
            if (typical[i] > hi && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Typical envelope buy: typical ${typical[i].toFixed(4)} above ${hi.toFixed(4)}`);
            }
            if (typical[i] < lo && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Typical envelope sell: typical ${typical[i].toFixed(4)} below ${lo.toFixed(4)}`);
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
