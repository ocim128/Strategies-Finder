import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
        decayFactor: Math.max(0.01, Math.min(0.99, Number(params.decayFactor ?? 0.85))),
    };
}

export const close_acceptance_decay_weighted_drift: Strategy = {
    name: "Close Acceptance Decay Weighted Drift",
    description: "Follows trend drifts when a normalized decay-weighted sum of close acceptance breaks out of a central range.",
    defaultParams: {
        lookback: 25,
        decayFactor: 0.85,
    },
    paramLabels: {
        lookback: "Lookback Window",
        decayFactor: "Decay Factor",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const decaySum = buildCumulativeDecaySum(acceptance, p.decayFactor as number);

        // Normalize sum to scale-invariant [0, 1] bounds using (decaySum * (1 - decayFactor) + 1) / 2
        const normalized = decaySum.map((val) => (val * (1 - (p.decayFactor as number)) + 1) / 2);

        return createSignalLoop(cleanData, [acceptance], (i) => {
            if (i < lookback) return null;
            const normVal = normalized[i];

            // Buy: normalized decay sum breaks above high threshold
            if (normVal > 0.70) {
                return createBuySignal(cleanData, i, `Close acceptance decay sum buy: normalized ${normVal.toFixed(2)}`);
            }
            // Sell: normalized decay sum breaks below low threshold
            if (normVal < 0.30) {
                return createSellSignal(cleanData, i, `Close acceptance decay sum sell: normalized ${normVal.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decayFactor"],
    },
};
