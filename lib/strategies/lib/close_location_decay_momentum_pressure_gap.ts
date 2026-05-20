import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 15))),
        decayFactor: Math.max(0.01, Math.min(0.99, Number(params.decayFactor ?? 0.85))),
        threshold: Math.max(0.1, Number(params.threshold ?? 2.5)),
    };
}

export const close_location_decay_momentum_pressure_gap: Strategy = {
    name: "Close Location Decay Momentum Pressure Gap",
    description: "Tracks decayed cumulative momentum of bar close locations relative to their high-low ranges on Binance, entering when spot builds pressure that Polymarket has underpriced in its pressure gap.",
    defaultParams: {
        lookback: 15,
        decayFactor: 0.85,
        threshold: 2.5,
    },
    paramLabels: {
        lookback: "Decay Lookback",
        decayFactor: "Decay Factor",
        threshold: "Momentum Threshold",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const decayFactor = p.decayFactor as number;
        const threshold = p.threshold as number;

        if (cleanData.length < lookback) return [];

        const closeLocations = buildCloseLocationSeries(cleanData);
        // Normalize close location series to [-0.5, 0.5]
        const normalizedLocs = closeLocations.map((loc) => loc - 0.5);
        const cumulativeDecay = buildCumulativeDecaySum(normalizedLocs, decayFactor);

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });

        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [cumulativeDecay, pressure.longEdge, pressure.shortEdge], (i) => {
            if (i < 1) return null;

            const sum = cumulativeDecay[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];

            if (sum === null || longEdge === null || shortEdge === null) return null;

            // Buy: decayed close location sum exceeds threshold, underpriced breakout side
            if (sum > threshold && longEdge >= 0.01) {
                return createBuySignal(cleanData, i, `Close location momentum ${sum.toFixed(2)} > threshold with long edge ${longEdge.toFixed(3)}`);
            }

            // Sell: decayed close location sum falls below negative threshold
            if (sum < -threshold && shortEdge >= 0.01) {
                return createSellSignal(cleanData, i, `Close location momentum ${sum.toFixed(2)} < -threshold with short edge ${shortEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decayFactor", "threshold"],
    },
};
