import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        gradientPercentileMin: Math.max(0.5, Math.min(0.99, Number(params.gradientPercentileMin ?? 0.65))),
    };
}

export const close_location_gradient_acceleration: Strategy = {
    name: "Close Location Gradient Acceleration",
    description: "Follows accelerating directional pressure when close location gradient percentile is elevated with level confirmation.",
    defaultParams: {
        lookback: 25,
        gradientPercentileMin: 0.65,
    },
    paramLabels: {
        lookback: "Lookback",
        gradientPercentileMin: "Min Gradient Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 3) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        // Gradient: rate of change of close location
        const gradient = buildRateOfChange(closeLocation, 1);
        const gradientClean = gradient.map(v => v ?? 0);
        const gradPctl = buildPercentileRank(gradientClean, lookback);
        const smoothedCL = buildRollingAverage(closeLocation, lookback);

        return createSignalLoop(cleanData, [gradPctl, smoothedCL], (i) => {
            const gp = gradPctl[i];
            const scl = smoothedCL[i];
            if (gp === null || scl === null) return null;

            const gradMin = p.gradientPercentileMin as number;

            if (gp > gradMin && scl > 0.55) {
                return createBuySignal(cleanData, i, `CL gradient pctl ${gp.toFixed(2)} smoothed CL ${scl.toFixed(2)} accelerating up`);
            }
            if (gp < (1 - gradMin) && scl < 0.45) {
                return createSellSignal(cleanData, i, `CL gradient pctl ${gp.toFixed(2)} smoothed CL ${scl.toFixed(2)} accelerating down`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "gradientPercentileMin"],
    },
};
