import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingCorrelation } from "./price-action-statistics-core";
import { buildPolymarket1sGammaConsensusMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeCumulativeInitiativeConvergenceGammaConsensusParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        minCorrelation: normalizeNumberParam(params.minCorrelation, 0.5, -1, 1),
    };
}

export const cumulative_initiative_convergence_gamma_consensus: Strategy = {
    name: "Cumulative Initiative Convergence with Gamma Consensus",
    description: "Trades initiative/return convergence only when Polymarket Gamma consensus agrees with the side.",
    defaultParams: {
        lookback: 30,
        minCorrelation: 0.5,
    },
    paramLabels: {
        lookback: "Lookback",
        minCorrelation: "Minimum Correlation",
    },
    normalizeParams: normalizeCumulativeInitiativeConvergenceGammaConsensusParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCumulativeInitiativeConvergenceGammaConsensusParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : (close - closes[i - 1]) / closes[i - 1]);
        const initiative = buildInitiativePressureSeries(cleanData, lookback).map((value) => value ?? 0);
        const correlation = buildRollingCorrelation(initiative, returns, lookback);
        const mask = buildPolymarket1sGammaConsensusMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [correlation], (i) => {
            const corr = correlation[i];
            if (corr === null || corr < p.minCorrelation) return null;

            if (returns[i] > 0 && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Initiative pressure converged with rising returns and Gamma consensus");
            }
            if (returns[i] < 0 && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Initiative pressure converged with falling returns and Gamma consensus");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minCorrelation"],
    },
};
