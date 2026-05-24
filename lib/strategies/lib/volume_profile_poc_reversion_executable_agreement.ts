import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildPolymarket1sExecutableAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import {
    getPreparedValueAreaData,
    getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeVolumeProfilePocReversionExecutableAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 60, 5),
        devThreshold: normalizeNumberParam(params.devThreshold, 0.05, 0),
    };
}

export const volume_profile_poc_reversion_executable_agreement: Strategy = {
    name: "Volume Profile POC Reversion with Executable Agreement",
    description: "Fades failed value-area boundary acceptance back toward POC only when the matching Polymarket executable agreement mask allows the side.",
    defaultParams: {
        lookback: 60,
        devThreshold: 0.05,
    },
    paramLabels: {
        lookback: "Lookback",
        devThreshold: "Minimum POC Deviation",
    },
    normalizeParams: normalizeVolumeProfilePocReversionExecutableAgreementParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedValueAreaData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeVolumeProfilePocReversionExecutableAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const typicals = getTypicalPrices(cleanData);
        const valueArea = getValueAreaSeries(prepared, lookback, 0.68, 12);
        const mask = buildPolymarket1sExecutableAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [valueArea.vah, valueArea.val, valueArea.poc], (i) => {
            if (i < lookback + 1) return null;
            const vah = valueArea.vah[i];
            const val = valueArea.val[i];
            const poc = valueArea.poc[i];
            const previousVah = valueArea.vah[i - 1];
            const previousVal = valueArea.val[i - 1];
            if (vah === null || val === null || poc === null || previousVah === null || previousVal === null) return null;

            if (
                typicals[i] <= poc - p.devThreshold
                && closes[i - 1] <= previousVal
                && closes[i] > val
                && mask.yesAllowed[i]
            ) {
                return createBuySignal(cleanData, i, "Failed value-area low acceptance with executable YES agreement");
            }
            if (
                typicals[i] >= poc + p.devThreshold
                && closes[i - 1] >= previousVah
                && closes[i] < vah
                && mask.noAllowed[i]
            ) {
                return createSellSignal(cleanData, i, "Failed value-area high acceptance with executable NO agreement");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];
        return volume_profile_poc_reversion_executable_agreement.executePrepared!(
            volume_profile_poc_reversion_executable_agreement.prepareFinderData!(data),
            params,
            data,
            context
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "devThreshold"],
    },
};
