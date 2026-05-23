import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
} from "../strategy-helpers";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import {
    getPreparedValueAreaData,
    getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeVolumeProfileValueAreaBreakoutExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 50, 3),
        valueAreaPct: normalizeNumberParam(params.valueAreaPct, 70, 10, 99),
        minEdge: normalizeNumberParam(params.minEdge, 0.015, 0),
    };
}

export const volume_profile_value_area_breakout_executable_edge: Strategy = {
    name: "Volume Profile Value Area Breakout Executable Edge",
    description: "Trades rolling value-area breakouts only when the matching Polymarket side is actionable and underpriced.",
    defaultParams: {
        lookback: 50,
        valueAreaPct: 70,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Lookback",
        valueAreaPct: "Value Area Percent",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeVolumeProfileValueAreaBreakoutExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedValueAreaData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeVolumeProfileValueAreaBreakoutExecutableEdgeParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const closes = prepared.closes;
        const valueArea = getValueAreaSeries(prepared, lookback, p.valueAreaPct / 100);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [valueArea.vah, valueArea.val], (i) => {
            if (i < lookback + 1) return null;
            const vah = valueArea.vah[i];
            const previousVah = valueArea.vah[i - 1];
            const val = valueArea.val[i];
            const previousVal = valueArea.val[i - 1];
            if (vah === null || previousVah === null || val === null || previousVal === null) return null;

            if (
                closes[i - 1] <= previousVah
                && closes[i] > vah
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Value area high breakout with executable YES edge");
            }
            if (
                closes[i - 1] >= previousVal
                && closes[i] < val
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Value area low breakdown with executable NO edge");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
        volume_profile_value_area_breakout_executable_edge.executePrepared!(
            volume_profile_value_area_breakout_executable_edge.prepareFinderData!(data),
            params,
            data,
            context
        ),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "valueAreaPct", "minEdge"],
    },
};
