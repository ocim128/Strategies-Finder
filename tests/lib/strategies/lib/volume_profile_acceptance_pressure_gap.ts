import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import {
    getPreparedValueAreaData,
    getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeVolumeProfileAcceptancePressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 50, 5),
        minEdge: normalizeNumberParam(params.minEdge, 0.025, 0),
    };
}

export const volume_profile_acceptance_pressure_gap: Strategy = {
    name: "Volume Profile Acceptance Fade with Pressure Gap",
    description: "Fades failed value-area boundary acceptance only when Polymarket pressure gap supports the reversion side.",
    defaultParams: {
        lookback: 50,
        minEdge: 0.025,
    },
    paramLabels: {
        lookback: "Value Area Lookback",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeVolumeProfileAcceptancePressureGapParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedValueAreaData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeVolumeProfileAcceptancePressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const typicals = getTypicalPrices(cleanData);
        const valueArea = getValueAreaSeries(prepared, lookback, 0.68, 12);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [valueArea.vah, valueArea.val, pressure.pressureGap], (i) => {
            const vah = valueArea.vah[i];
            const val = valueArea.val[i];
            const gap = pressure.pressureGap[i];
            if (vah === null || val === null || gap === null) return null;

            if (typicals[i] < val && closes[i] > val && gap >= p.minEdge) {
                return createBuySignal(cleanData, i, "Value area low rejection with positive Polymarket pressure gap");
            }
            if (typicals[i] > vah && closes[i] < vah && gap <= -p.minEdge) {
                return createSellSignal(cleanData, i, "Value area high rejection with negative Polymarket pressure gap");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
        volume_profile_acceptance_pressure_gap.executePrepared!(
            volume_profile_acceptance_pressure_gap.prepareFinderData!(data),
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
