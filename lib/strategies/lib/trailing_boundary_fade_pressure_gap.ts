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

function normalizeTrailingBoundaryFadePressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 45, 5),
        channelWidthPct: normalizeNumberParam(params.channelWidthPct, 0.05, 0),
        minEdge: normalizeNumberParam(params.minEdge, 0.025, 0),
    };
}

export const trailing_boundary_fade_pressure_gap: Strategy = {
    name: "Trailing Boundary Fade with Pressure Gap",
    description: "Fades breaches of prior rolling typical-price channels when channel width is sufficient and Polymarket pressure edge supports reversion.",
    defaultParams: {
        lookback: 45,
        channelWidthPct: 0.05,
        minEdge: 0.025,
    },
    paramLabels: {
        lookback: "Lookback",
        channelWidthPct: "Minimum Channel Width Percent",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeTrailingBoundaryFadePressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeTrailingBoundaryFadePressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const boundary = buildRollingMinMax(typicals, lookback, false);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [boundary.min, boundary.max, pressure.longEdge, pressure.shortEdge], (i) => {
            const low = boundary.min[i];
            const high = boundary.max[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (low === null || high === null || longEdge === null || shortEdge === null) return null;

            const widthPct = typicals[i] > 0 ? (high - low) / typicals[i] : 0;
            if (widthPct < p.channelWidthPct) return null;

            if (typicals[i] <= low && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "Prior channel low breach with YES pressure edge");
            }
            if (typicals[i] >= high && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "Prior channel high breach with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "channelWidthPct", "minEdge"],
    },
};
