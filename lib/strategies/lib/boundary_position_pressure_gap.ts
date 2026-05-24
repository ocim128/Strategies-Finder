import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingMinMax } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeBoundaryPositionPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 50, 5),
        thresholdPct: normalizeNumberParam(params.thresholdPct, 0.1, 0, 0.5),
        minEdge: normalizeNumberParam(params.minEdge, 0.025, 0),
    };
}

export const boundary_position_pressure_gap: Strategy = {
    name: "Boundary Position with Pressure Gap",
    description: "Fades rolling typical-price range boundaries only when Polymarket pressure gap shows same-side underpricing.",
    defaultParams: {
        lookback: 50,
        thresholdPct: 0.1,
        minEdge: 0.025,
    },
    paramLabels: {
        lookback: "Lookback",
        thresholdPct: "Boundary Proximity Percent",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeBoundaryPositionPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeBoundaryPositionPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const boundary = buildRollingMinMax(typicals, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [boundary.min, boundary.max, pressure.longEdge, pressure.shortEdge], (i) => {
            const low = boundary.min[i];
            const high = boundary.max[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (low === null || high === null || longEdge === null || shortEdge === null) return null;

            const width = high - low;
            if (width <= 0) return null;
            const lowProximity = (typicals[i] - low) / width;
            const highProximity = (high - typicals[i]) / width;

            if (lowProximity <= p.thresholdPct && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "Typical price near range low with YES pressure edge");
            }
            if (highProximity <= p.thresholdPct && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "Typical price near range high with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "thresholdPct", "minEdge"],
    },
};
