import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeEventOpenDistancePressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: normalizeIntegerParam(params.volLookback, 50, 5),
        minEdge: normalizeNumberParam(params.minEdge, 0.03, 0),
    };
}

export const event_open_distance_pressure_gap: Strategy = {
    name: "Event Open Distance with Pressure Gap",
    description: "Trades event-open distance dislocations only when the Polymarket pressure gap shows same-side underpricing.",
    defaultParams: {
        volLookback: 50,
        minEdge: 0.03,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeEventOpenDistancePressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEventOpenDistancePressureGapParams(params);
        if (cleanData.length < p.volLookback + 1) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: p.volLookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [pressure.distanceZ, pressure.pressureGap], (i) => {
            const distanceZ = pressure.distanceZ[i];
            const pressureGap = pressure.pressureGap[i];
            if (distanceZ === null || pressureGap === null) return null;

            if (distanceZ > 1.0 && pressureGap >= p.minEdge) {
                return createBuySignal(cleanData, i, "Positive event-open distance with YES pressure gap");
            }
            if (distanceZ < -1.0 && pressureGap <= -p.minEdge) {
                return createSellSignal(cleanData, i, "Negative event-open distance with NO pressure gap");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "minEdge"],
    },
};
