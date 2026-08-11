import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";

const SURGE_THRESHOLD = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const initiative_pressure_surge: Strategy = {
    name: "Initiative Pressure Surge",
    description: "Rides fresh surges of volume-weighted close acceptance (initiative pressure) past fixed signed thresholds.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Volume Baseline Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        // Pressure = close acceptance ([-1, 1]) scaled by relative volume
        // clamped to [0, 3]; volume enters only as a relative share.
        const pressure = buildInitiativePressureSeries(cleanData, lookback);

        return createSignalLoop(cleanData, [pressure], (i) => {
            const curr = pressure[i];
            const prev = pressure[i - 1];
            if (curr === null || prev === null) return null;

            // Fire on threshold entry edges only, so a sustained surge is not
            // re-entered every bar.
            if (prev < SURGE_THRESHOLD && curr >= SURGE_THRESHOLD) {
                return createBuySignal(cleanData, i, `Pressure surge buy: pressure ${curr.toFixed(2)} crossed above ${SURGE_THRESHOLD}`);
            }
            if (prev > -SURGE_THRESHOLD && curr <= -SURGE_THRESHOLD) {
                return createSellSignal(cleanData, i, `Pressure surge sell: pressure ${curr.toFixed(2)} crossed below ${-SURGE_THRESHOLD}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
