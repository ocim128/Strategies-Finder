import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateCMF } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";
import { buildPolymarket1sExecutableAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeCmfAccelerationExecutableAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        accelThreshold: normalizeNumberParam(params.accelThreshold, 0.18, 0),
    };
}

export const cmf_acceleration_executable_agreement: Strategy = {
    name: "Chaikin Money Flow Acceleration with Executable Agreement",
    description: "Trades CMF acceleration only when Polymarket executable agreement allows the side.",
    defaultParams: {
        lookback: 20,
        accelThreshold: 0.18,
    },
    paramLabels: {
        lookback: "CMF Lookback",
        accelThreshold: "CMF Acceleration Threshold",
    },
    normalizeParams: normalizeCmfAccelerationExecutableAgreementParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCmfAccelerationExecutableAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 4) return [];

        const cmf = calculateCMF(
            getHighs(cleanData),
            getLows(cleanData),
            getCloses(cleanData),
            getVolumes(cleanData),
            lookback
        );
        const cmfRoc = buildRateOfChange(cmf.map((value) => value ?? 0), 3);
        const mask = buildPolymarket1sExecutableAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [cmf, cmfRoc], (i) => {
            const flow = cmf[i];
            const acceleration = cmfRoc[i];
            if (flow === null || acceleration === null) return null;

            if (flow > 0 && acceleration >= p.accelThreshold && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Positive CMF acceleration with executable YES agreement");
            }
            if (flow < 0 && acceleration <= -p.accelThreshold && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Negative CMF acceleration with executable NO agreement");
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
