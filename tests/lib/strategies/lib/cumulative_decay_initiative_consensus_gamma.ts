import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";
import { buildPolymarket1sGammaAgreement } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import { nullsToZero } from "./polymarket-1s-strategy-utils";

function normalizeCumulativeDecayInitiativeConsensusGammaParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 2),
        decayFactor: normalizeNumberParam(params.decayFactor, 0.88, 0.01, 0.999),
        minEdge: normalizeNumberParam(params.minEdge, 0.015, 0),
    };
}

export const cumulative_decay_initiative_consensus_gamma: Strategy = {
    name: "Cumulative Decay Initiative Consensus Gamma",
    description: "Uses decayed Binance initiative pressure as the primary signal and Gamma consensus as confirmation.",
    defaultParams: {
        lookback: 20,
        decayFactor: 0.88,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Lookback",
        decayFactor: "Decay Factor",
        minEdge: "Minimum Consensus Edge",
    },
    normalizeParams: normalizeCumulativeDecayInitiativeConsensusGammaParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCumulativeDecayInitiativeConsensusGammaParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const decayedInitiative = buildCumulativeDecaySum(nullsToZero(initiative), p.decayFactor);
        const gamma = buildPolymarket1sGammaAgreement(cleanData, context, { volLookback: lookback });
        if (!gamma.available) return [];

        return createSignalLoop(cleanData, [initiative, gamma.consensusLongEdge, gamma.consensusShortEdge], (i) => {
            if (i < lookback) return null;

            if (decayedInitiative[i] > 1.5 && (gamma.consensusLongEdge[i] ?? -Infinity) >= p.minEdge) {
                return createBuySignal(cleanData, i, "Decayed initiative pressure with long Gamma consensus");
            }
            if (decayedInitiative[i] < -1.5 && (gamma.consensusShortEdge[i] ?? -Infinity) >= p.minEdge) {
                return createSellSignal(cleanData, i, "Decayed initiative pressure with short Gamma consensus");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decayFactor", "minEdge"],
    },
};
