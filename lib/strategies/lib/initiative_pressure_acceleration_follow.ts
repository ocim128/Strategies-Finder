import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 35))),
        accThreshold: Number(params.accThreshold ?? 0.30),
    };
}

export const initiative_pressure_acceleration_follow: Strategy = {
    name: "Initiative Pressure Acceleration Follow",
    description: "Follows trend breakouts when initiative pressure average velocity accelerates, confirmed by volume.",
    defaultParams: {
        lookback: 35,
        accThreshold: 0.30,
    },
    paramLabels: {
        lookback: "Lookback Window",
        accThreshold: "Acceleration Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const volumes = getVolumes(cleanData);
        const volPct = buildPercentileRank(volumes, lookback);

        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const pressureClean = pressure.map((v) => v ?? 0);

        const avgPressure = buildRollingAverage(pressureClean, lookback);
        const avgPressureClean = avgPressure.map((v) => v ?? 0);

        const pressureAcc = buildRateOfChange(avgPressureClean, 1);

        return createSignalLoop(cleanData, [volPct, pressureAcc, pressure], (i) => {
            const vp = volPct[i];
            const acc = pressureAcc[i];
            const pr = pressure[i];
            if (vp === null || acc === null || pr === null) return null;

            // Buy: volume percentile above median, and pressure average accelerates positively
            if (vp > 0.50 && acc > p.accThreshold) {
                return createBuySignal(cleanData, i, `Initiative pressure acceleration buy: Acc ${acc.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
            }
            // Sell: volume percentile above median, and pressure average accelerates negatively
            if (vp > 0.50 && acc < -p.accThreshold) {
                return createSellSignal(cleanData, i, `Initiative pressure acceleration sell: Acc ${acc.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "accThreshold"],
    },
};
