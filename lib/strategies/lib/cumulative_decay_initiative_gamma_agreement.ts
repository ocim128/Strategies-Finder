import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";
import { buildPolymarket1sGammaConsensusMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeCumulativeDecayInitiativeGammaAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        decay: normalizeNumberParam(params.decay, 0.85, 0.01, 0.999),
        threshold: normalizeNumberParam(params.threshold, 3.0, 0),
    };
}

export const cumulative_decay_initiative_gamma_agreement: Strategy = {
    name: "Cumulative Decay Initiative with Gamma Agreement",
    description: "Trades decayed cumulative initiative pressure only when Polymarket Gamma consensus agrees with the side.",
    defaultParams: {
        lookback: 25,
        decay: 0.85,
        threshold: 3.0,
    },
    paramLabels: {
        lookback: "Initiative Lookback",
        decay: "Decay Factor",
        threshold: "Cumulative Pressure Threshold",
    },
    normalizeParams: normalizeCumulativeDecayInitiativeGammaAgreementParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCumulativeDecayInitiativeGammaAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const decayed = buildCumulativeDecaySum(initiative.map((value) => value ?? 0), p.decay);
        const mask = buildPolymarket1sGammaConsensusMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback) return null;

            if (decayed[i] >= p.threshold && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Decayed initiative pressure with Gamma long consensus");
            }
            if (decayed[i] <= -p.threshold && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Decayed initiative pressure with Gamma short consensus");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decay", "threshold"],
    },
};
