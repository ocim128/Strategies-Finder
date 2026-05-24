import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildPolymarket1sExecutableAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeCloseAcceptanceExecutableAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 40, 5),
        minAcceptance: normalizeNumberParam(params.minAcceptance, 0.7, 0.5, 1),
    };
}

export const close_acceptance_executable_agreement: Strategy = {
    name: "Close Acceptance with Executable Agreement",
    description: "Trades directional close-acceptance migration only when the matching Polymarket side has executable agreement.",
    defaultParams: {
        lookback: 40,
        minAcceptance: 0.7,
    },
    paramLabels: {
        lookback: "Lookback",
        minAcceptance: "Minimum Acceptance",
    },
    normalizeParams: normalizeCloseAcceptanceExecutableAgreementParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCloseAcceptanceExecutableAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const acceptanceAverage = buildRollingAverage(buildCloseAcceptanceSeries(cleanData), lookback);
        const mask = buildPolymarket1sExecutableAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [acceptanceAverage], (i) => {
            const acceptance = acceptanceAverage[i];
            if (acceptance === null) return null;

            const directionalRatio = (acceptance + 1) / 2;
            if (directionalRatio >= p.minAcceptance && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Bullish close acceptance with executable YES agreement");
            }
            if (directionalRatio <= 1 - p.minAcceptance && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Bearish close acceptance with executable NO agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minAcceptance"],
    },
};
