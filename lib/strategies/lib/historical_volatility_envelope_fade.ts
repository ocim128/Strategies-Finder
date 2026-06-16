import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingStdDev } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        multiplier: Math.max(0.01, Number(params.multiplier ?? 2.0)),
    };
}

export const historical_volatility_envelope_fade: Strategy = {
    name: "Historical Volatility Envelope Fade",
    description: "Fades ratio price moves when Typical Price deviates from its rolling average by a multiplier of its rolling standard deviation.",
    defaultParams: {
        lookback: 30,
        multiplier: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        multiplier: "StdDev Multiplier",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const typical = getTypicalPrices(cleanData);
        const rollingAvg = buildRollingAverage(typical, lookback);
        const rollingStd = buildRollingStdDev(typical, lookback);

        return createSignalLoop(cleanData, [rollingAvg, rollingStd], (i) => {
            const avg = rollingAvg[i];
            const std = rollingStd[i];
            if (avg === null || std === null) return null;

            const tp = typical[i];

            // Buy: price is below bottom envelope
            if (tp < avg - p.multiplier * std) {
                return createBuySignal(cleanData, i, `Historical volatility envelope buy: Typical ${tp.toFixed(4)} < Envelope ${(avg - p.multiplier * std).toFixed(4)}`);
            }
            // Sell: price is above top envelope
            if (tp > avg + p.multiplier * std) {
                return createSellSignal(cleanData, i, `Historical volatility envelope sell: Typical ${tp.toFixed(4)} > Envelope ${(avg + p.multiplier * std).toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "multiplier"],
    },
};
