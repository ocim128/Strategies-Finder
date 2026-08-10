import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeBodyMidThrustGateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        thrustThreshold: Math.max(0.05, Math.min(0.9, Number(params.thrustThreshold ?? 0.3))),
    };
}

export const body_mid_thrust_gate: Strategy = {
    name: "Body Mid Thrust Gate",
    description: "Follows wick-robust body-mid displacements beyond a magic fraction of the average range as thrusts.",
    defaultParams: {
        thrustThreshold: 0.3,
    },
    paramLabels: {
        thrustThreshold: "Thrust Threshold",
    },
    normalizeParams: normalizeBodyMidThrustGateParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBodyMidThrustGateParams(params);
        const thrustThreshold = p.thrustThreshold as number;
        if (cleanData.length < 2) return [];

        // statistics-core bodyMidDelta is normalized by the average of the adjacent
        // ranges, so the magic threshold is a true fraction of range and portable
        // across ratio pairs (the frequency-core variant is raw price displacement).
        const bodyMidDelta = extractBarMetricSeries(cleanData, "bodyMidDelta");

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            if (bodyMidDelta[i] > thrustThreshold) {
                return createBuySignal(cleanData, i, `Body-mid thrust: ${bodyMidDelta[i].toFixed(3)} of average range`);
            }
            if (bodyMidDelta[i] < -thrustThreshold) {
                return createSellSignal(cleanData, i, `Body-mid thrust: ${bodyMidDelta[i].toFixed(3)} of average range`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["thrustThreshold"],
    },
};
