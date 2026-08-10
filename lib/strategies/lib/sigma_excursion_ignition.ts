import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    extractBarMetricSeries,
    buildRollingZScore,
    buildThresholdCrossingCount,
} from "./price-action-statistics-core";

function normalizeSigmaExcursionIgnitionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const sigma_excursion_ignition: Strategy = {
    name: "Sigma Excursion Ignition",
    description: "Follows the first fresh crossing of a fixed return z-score band after a quiet stretch of few band excursions.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeSigmaExcursionIgnitionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSigmaExcursionIgnitionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const z = buildRollingZScore(closeReturn, lookback);
        const zClean = z.map((v) => v ?? 0);
        const crossings = buildThresholdCrossingCount(zClean, lookback, 1.5);

        return createSignalLoop(cleanData, [z, crossings], (i) => {
            if (i < lookback) return null;
            const currZ = z[i];
            const prevZ = z[i - 1];
            const priorCrossings = crossings[i - 1];
            if (currZ === null || prevZ === null || priorCrossings === null) return null;

            if (currZ > 1.5 && prevZ <= 1.5 && priorCrossings <= 1) {
                return createBuySignal(cleanData, i, `Fresh +1.5 sigma band crossing from quiet excursion regime (prior crossings ${priorCrossings})`);
            }
            if (currZ < -1.5 && prevZ >= -1.5 && priorCrossings <= 1) {
                return createSellSignal(cleanData, i, `Fresh -1.5 sigma band crossing from quiet excursion regime (prior crossings ${priorCrossings})`);
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
