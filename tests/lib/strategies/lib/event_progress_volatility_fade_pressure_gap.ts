import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeEventProgressVolatilityFadePressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: normalizeIntegerParam(params.volLookback, 50, 5),
        devThreshold: normalizeNumberParam(params.devThreshold, 1.8, 0.1),
        minEdge: normalizeNumberParam(params.minEdge, 0.03, 0),
    };
}

export const event_progress_volatility_fade_pressure_gap: Strategy = {
    name: "Event Progress Volatility Fade with Pressure Gap",
    description: "Fades event-open distance extremes after early-event noise when Polymarket pressure edge supports reversion.",
    defaultParams: {
        volLookback: 50,
        devThreshold: 1.8,
        minEdge: 0.03,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        devThreshold: "Distance Z-Score Threshold",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeEventProgressVolatilityFadePressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEventProgressVolatilityFadePressureGapParams(params);
        if (cleanData.length < p.volLookback + 1) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: p.volLookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [pressure.distanceZ, pressure.eventProgress, pressure.longEdge, pressure.shortEdge], (i) => {
            const distanceZ = pressure.distanceZ[i];
            const eventProgress = pressure.eventProgress[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (distanceZ === null || eventProgress === null || longEdge === null || shortEdge === null) return null;
            if (eventProgress < 0.2) return null;

            if (distanceZ <= -p.devThreshold && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "Negative event distance extreme with YES pressure edge");
            }
            if (distanceZ >= p.devThreshold && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "Positive event distance extreme with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "devThreshold", "minEdge"],
    },
};
