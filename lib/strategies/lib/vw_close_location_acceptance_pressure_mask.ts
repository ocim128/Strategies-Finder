import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPolymarket1sPressureAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function buildVolumeWeightedCloseLocationAverage(
    closeLocation: number[],
    volumes: number[],
    lookbackInput: number
): (number | null)[] {
    const lookback = Math.max(1, Math.round(lookbackInput));
    const result: (number | null)[] = new Array(closeLocation.length).fill(null);
    let weightedSum = 0;
    let volumeSum = 0;

    for (let i = 0; i < closeLocation.length; i++) {
        const volume = Math.max(0, volumes[i]);
        weightedSum += closeLocation[i] * volume;
        volumeSum += volume;

        if (i >= lookback) {
            const oldVolume = Math.max(0, volumes[i - lookback]);
            weightedSum -= closeLocation[i - lookback] * oldVolume;
            volumeSum -= oldVolume;
        }

        if (i >= lookback - 1 && volumeSum > 0) {
            result[i] = weightedSum / volumeSum;
        }
    }

    return result;
}

function normalizeVwCloseLocationAcceptancePressureMaskParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        clvThreshold: normalizeNumberParam(params.clvThreshold, 0.72, 0.5, 1),
    };
}

export const vw_close_location_acceptance_pressure_mask: Strategy = {
    name: "Volume-Weighted Close Location Acceptance with Pressure Mask",
    description: "Trades volume-weighted close-location acceptance only when Polymarket pressure agreement allows the side.",
    defaultParams: {
        lookback: 25,
        clvThreshold: 0.72,
    },
    paramLabels: {
        lookback: "Lookback",
        clvThreshold: "Close Location Threshold",
    },
    normalizeParams: normalizeVwCloseLocationAcceptancePressureMaskParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVwCloseLocationAcceptancePressureMaskParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const weightedClv = buildVolumeWeightedCloseLocationAverage(
            buildCloseLocationSeries(cleanData),
            getVolumes(cleanData),
            lookback
        );
        const mask = buildPolymarket1sPressureAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [weightedClv], (i) => {
            const value = weightedClv[i];
            if (value === null) return null;

            if (value >= p.clvThreshold && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Volume-weighted close location acceptance with pressure long agreement");
            }
            if (value <= 1 - p.clvThreshold && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Volume-weighted close location acceptance with pressure short agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "clvThreshold"],
    },
};
