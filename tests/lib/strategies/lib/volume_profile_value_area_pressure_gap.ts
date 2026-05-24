import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
} from "../strategy-helpers";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import {
    getPreparedValueAreaData,
    getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeVolumeProfileValueAreaPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 60, 5),
        minEdge: normalizeNumberParam(params.minEdge, 0.03, 0),
    };
}

export const volume_profile_value_area_pressure_gap: Strategy = {
    name: "Volume Profile Value Area with Pressure Gap",
    description: "Trades rolling value-area breakouts only when the Polymarket pressure gap supports the breakout side.",
    defaultParams: {
        lookback: 60,
        minEdge: 0.03,
    },
    paramLabels: {
        lookback: "Value Area Lookback",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeVolumeProfileValueAreaPressureGapParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedValueAreaData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeVolumeProfileValueAreaPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const valueArea = getValueAreaSeries(prepared, lookback, 0.68, 12);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [valueArea.vah, valueArea.val, pressure.pressureGap], (i) => {
            const vah = valueArea.vah[i];
            const val = valueArea.val[i];
            const gap = pressure.pressureGap[i];
            if (vah === null || val === null || gap === null) return null;

            if (prepared.closes[i] > vah && gap >= p.minEdge) {
                return createBuySignal(cleanData, i, "Close above value area high with positive Polymarket pressure gap");
            }
            if (prepared.closes[i] < val && gap <= -p.minEdge) {
                return createSellSignal(cleanData, i, "Close below value area low with negative Polymarket pressure gap");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
        volume_profile_value_area_pressure_gap.executePrepared!(
            volume_profile_value_area_pressure_gap.prepareFinderData!(data),
            params,
            data,
            context
        ),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEdge"],
    },
};
