import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRateOfChange,
    buildRollingZScore,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

const SPIKE_BAND = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(20, Math.round(Number(params.lookback ?? 60))),
    };
}

export const post_spike_stabilization: Strategy = {
    name: "Post Spike Stabilization",
    description: "Fades a panic or euphoria bar only when the next open no longer discounts the shock.",
    defaultParams: {
        lookback: 60,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        // One-bar returns with the leading null coerced, then standardized.
        const returns = buildRateOfChange(getCloses(cleanData), 1).map((v) => (v === null ? 0 : v));
        const returnZ = buildRollingZScore(returns, lookback);
        const gapPct = extractBarMetricSeries(cleanData, "gapPct");

        return createSignalLoop(cleanData, [returnZ], (i) => {
            if (i < lookback) return null;
            const spikeZ = returnZ[i - 1];
            if (spikeZ === null) return null;

            // Panic bar, then an open that does not gap down.
            if (spikeZ <= -SPIKE_BAND && gapPct[i] >= 0) {
                return createBuySignal(cleanData, i, `Post-spike buy: prior return z ${spikeZ.toFixed(2)}, gap ${(gapPct[i] * 100).toFixed(3)}%`);
            }
            // Euphoria bar, then an open that does not gap up.
            if (spikeZ >= SPIKE_BAND && gapPct[i] <= 0) {
                return createSellSignal(cleanData, i, `Post-spike sell: prior return z ${spikeZ.toFixed(2)}, gap ${(gapPct[i] * 100).toFixed(3)}%`);
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
