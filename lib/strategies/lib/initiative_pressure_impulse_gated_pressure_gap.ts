import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeInitiativePressureImpulseGatedPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        pressureThreshold: normalizeNumberParam(params.pressureThreshold, 0.4, 0),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

export const initiative_pressure_impulse_gated_pressure_gap: Strategy = {
    name: "Initiative Pressure Impulse with Pressure Gap",
    description: "Trades sustained volume-weighted initiative pressure only when Polymarket pressure edge has not caught up.",
    defaultParams: {
        lookback: 20,
        pressureThreshold: 0.4,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        pressureThreshold: "Initiative Pressure Threshold",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeInitiativePressureImpulseGatedPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureImpulseGatedPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const cumulativeInitiative = buildRollingAverage(initiative.map((value) => value ?? 0), lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [initiative, cumulativeInitiative, pressure.longEdge, pressure.shortEdge], (i) => {
            const impulse = cumulativeInitiative[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (impulse === null || longEdge === null || shortEdge === null) return null;

            if (impulse >= p.pressureThreshold && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "Positive initiative impulse with YES pressure edge");
            }
            if (impulse <= -p.pressureThreshold && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "Negative initiative impulse with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pressureThreshold", "minEdge"],
    },
};
