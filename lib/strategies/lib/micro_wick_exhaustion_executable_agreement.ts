import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { computePriceActionBarMetrics } from "./price-action-frequency-core";
import { buildRollingMinMax, buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sExecutableAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeMicroWickExhaustionExecutableAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        wickRatio: normalizeNumberParam(params.wickRatio, 0.68, 0, 1),
    };
}

export const micro_wick_exhaustion_executable_agreement: Strategy = {
    name: "Micro Wick Exhaustion with Executable Agreement",
    description: "Fades high-volume wick rejections at trailing extremes only when Polymarket executable agreement allows the side.",
    defaultParams: {
        lookback: 20,
        wickRatio: 0.68,
    },
    paramLabels: {
        lookback: "Lookback",
        wickRatio: "Minimum Wick Ratio",
    },
    normalizeParams: normalizeMicroWickExhaustionExecutableAgreementParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeMicroWickExhaustionExecutableAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const boundary = buildRollingMinMax(typicals, lookback);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), lookback);
        const lowerWickRatio: number[] = new Array(cleanData.length).fill(0);
        const upperWickRatio: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const metrics = computePriceActionBarMetrics(cleanData[i]);
            if (metrics.range <= 0) continue;
            lowerWickRatio[i] = metrics.lowerWick / metrics.range;
            upperWickRatio[i] = metrics.upperWick / metrics.range;
        }

        const mask = buildPolymarket1sExecutableAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [boundary.min, boundary.max, volumeZ], (i) => {
            const low = boundary.min[i];
            const high = boundary.max[i];
            const volumeScore = volumeZ[i];
            if (low === null || high === null || volumeScore === null || volumeScore <= 1.2) return null;

            if (
                typicals[i] <= low
                && lowerWickRatio[i] >= p.wickRatio
                && mask.yesAllowed[i]
            ) {
                return createBuySignal(cleanData, i, "Lower-wick exhaustion at range low with executable YES agreement");
            }
            if (
                typicals[i] >= high
                && upperWickRatio[i] >= p.wickRatio
                && mask.noAllowed[i]
            ) {
                return createSellSignal(cleanData, i, "Upper-wick exhaustion at range high with executable NO agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "wickRatio"],
    },
};
