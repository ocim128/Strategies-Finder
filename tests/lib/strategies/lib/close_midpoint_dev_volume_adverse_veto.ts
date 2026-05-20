import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeCloseMidpointDevVolumeAdverseVetoParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 3),
        volumeZThreshold: normalizeNumberParam(params.volumeZThreshold, 1.8, 0),
        maxAdverse: normalizeNumberParam(params.maxAdverse, 0.03, 0),
    };
}

export const close_midpoint_dev_volume_adverse_veto: Strategy = {
    name: "Close Midpoint Deviation Volume Adverse Veto",
    description: "Fades high-volume close-midpoint extremes unless Polymarket adverse pressure has already priced the reversion.",
    defaultParams: {
        lookback: 25,
        volumeZThreshold: 1.8,
        maxAdverse: 0.03,
    },
    paramLabels: {
        lookback: "Lookback",
        volumeZThreshold: "Volume Z Threshold",
        maxAdverse: "Max Adverse Pressure",
    },
    normalizeParams: normalizeCloseMidpointDevVolumeAdverseVetoParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCloseMidpointDevVolumeAdverseVetoParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const midpointDeviation = extractBarMetricSeries(cleanData, "closeMidpointDev");
        const deviationZ = buildRollingZScore(midpointDeviation, lookback);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [deviationZ, volumeZ, pressure.longAdverse, pressure.shortAdverse], (i) => {
            if (i < lookback) return null;
            if ((volumeZ[i] ?? -Infinity) <= p.volumeZThreshold) return null;

            if ((deviationZ[i] ?? Infinity) < -1.5 && (pressure.longAdverse[i] ?? Infinity) <= p.maxAdverse) {
                return createBuySignal(cleanData, i, "High-volume downside midpoint absorption with controlled long adverse pressure");
            }
            if ((deviationZ[i] ?? -Infinity) > 1.5 && (pressure.shortAdverse[i] ?? Infinity) <= p.maxAdverse) {
                return createSellSignal(cleanData, i, "High-volume upside midpoint absorption with controlled short adverse pressure");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volumeZThreshold", "maxAdverse"],
    },
};
