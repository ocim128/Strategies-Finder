import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sExecutableAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeCloseLocationAccelerationExecutableAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        accelThreshold: normalizeNumberParam(params.accelThreshold, 1.6, 0),
    };
}

export const close_location_acceleration_executable_agreement: Strategy = {
    name: "Close Location Value Acceleration with Executable Agreement",
    description: "Trades z-scored close-location acceleration only when Polymarket executable agreement allows the side.",
    defaultParams: {
        lookback: 20,
        accelThreshold: 1.6,
    },
    paramLabels: {
        lookback: "Lookback",
        accelThreshold: "Acceleration Z-Score Threshold",
    },
    normalizeParams: normalizeCloseLocationAccelerationExecutableAgreementParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCloseLocationAccelerationExecutableAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 4) return [];

        const smoothedClv = buildRollingAverage(buildCloseLocationSeries(cleanData), lookback);
        const smoothedValues = smoothedClv.map((value) => value ?? 0.5);
        const clvRoc = buildRateOfChange(smoothedValues, 3);
        const accelerationZ = buildRollingZScore(clvRoc.map((value) => value ?? 0), lookback);
        const mask = buildPolymarket1sExecutableAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [smoothedClv, clvRoc, accelerationZ], (i) => {
            const score = accelerationZ[i];
            if (score === null) return null;

            if (score >= p.accelThreshold && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Close-location acceleration with executable YES agreement");
            }
            if (score <= -p.accelThreshold && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Close-location acceleration with executable NO agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "accelThreshold"],
    },
};
