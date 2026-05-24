import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sPressureAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeVolumeWeightedCloseLocationPressureVetoParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 15, 5),
        threshold: normalizeNumberParam(params.threshold, 0.5, 0),
    };
}

export const volume_weighted_close_location_pressure_veto: Strategy = {
    name: "Volume-Weighted Close Location with Pressure Veto",
    description: "Trades smoothed volume-weighted close-location pressure only when Polymarket pressure agreement allows the side.",
    defaultParams: {
        lookback: 15,
        threshold: 0.5,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Pressure Threshold",
    },
    normalizeParams: normalizeVolumeWeightedCloseLocationPressureVetoParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeWeightedCloseLocationPressureVetoParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), lookback);
        const weightedPressure = closeLocation.map((value, i) => {
            const signedLocation = value * 2 - 1;
            const positiveVolumeScore = Math.max(0, volumeZ[i] ?? 0);
            return signedLocation * positiveVolumeScore;
        });
        const smoothedPressure = buildRollingAverage(weightedPressure, lookback);
        const mask = buildPolymarket1sPressureAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [smoothedPressure], (i) => {
            const pressure = smoothedPressure[i];
            if (pressure === null) return null;

            if (pressure >= p.threshold && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Volume-weighted close location pressure with Polymarket long agreement");
            }
            if (pressure <= -p.threshold && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Volume-weighted close location pressure with Polymarket short agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold"],
    },
};
