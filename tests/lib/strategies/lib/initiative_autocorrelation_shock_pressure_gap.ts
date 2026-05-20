import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import { nullsToZero } from "./polymarket-1s-strategy-utils";

function normalizeInitiativeAutocorrelationShockPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 3),
        autocorrThreshold: normalizeNumberParam(params.autocorrThreshold, -0.25, -1, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.01, 0),
    };
}

export const initiative_autocorrelation_shock_pressure_gap: Strategy = {
    name: "Initiative Autocorrelation Shock Pressure Gap",
    description: "Trades initiative-pressure autocorrelation shocks only when Polymarket pressure gap confirms same-side underpricing.",
    defaultParams: {
        lookback: 20,
        autocorrThreshold: -0.25,
        minEdge: 0.01,
    },
    paramLabels: {
        lookback: "Lookback",
        autocorrThreshold: "Autocorrelation Threshold",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeInitiativeAutocorrelationShockPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativeAutocorrelationShockPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 3) return [];

        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const initiativeValues = nullsToZero(initiative);
        const autocorr = buildRollingAutoCorrelation(initiativeValues, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [initiative, autocorr, pressure.longEdge, pressure.shortEdge], (i) => {
            if (i < lookback + 1 || (autocorr[i] ?? Infinity) >= p.autocorrThreshold) return null;

            if (initiativeValues[i] > 0 && (pressure.longEdge[i] ?? -Infinity) >= p.minEdge) {
                return createBuySignal(cleanData, i, "Initiative autocorrelation shock with long pressure edge");
            }
            if (initiativeValues[i] < 0 && (pressure.shortEdge[i] ?? -Infinity) >= p.minEdge) {
                return createSellSignal(cleanData, i, "Initiative autocorrelation shock with short pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "autocorrThreshold", "minEdge"],
    },
};
