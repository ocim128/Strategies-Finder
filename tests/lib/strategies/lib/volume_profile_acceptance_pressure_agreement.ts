import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildPolymarket1sPressureAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam } from "./range-conviction-core";
import {
    getPreparedValueAreaData,
    getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeVolumeProfileAcceptancePressureAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 55, 5),
        acceptanceBars: normalizeIntegerParam(params.acceptanceBars, 3, 1),
    };
}

export const volume_profile_acceptance_pressure_agreement: Strategy = {
    name: "Volume Profile Acceptance with Pressure Agreement",
    description: "Trades multi-bar acceptance outside rolling value-area boundaries only when Polymarket pressure agreement allows the side.",
    defaultParams: {
        lookback: 55,
        acceptanceBars: 3,
    },
    paramLabels: {
        lookback: "Value Area Lookback",
        acceptanceBars: "Acceptance Bars",
    },
    normalizeParams: normalizeVolumeProfileAcceptancePressureAgreementParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedValueAreaData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeVolumeProfileAcceptancePressureAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + p.acceptanceBars) return [];

        const typicals = getTypicalPrices(cleanData);
        const valueArea = getValueAreaSeries(prepared, lookback, 0.68, 12);
        const acceptedAbove: number[] = new Array(cleanData.length).fill(0);
        const acceptedBelow: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const vah = valueArea.vah[i];
            const val = valueArea.val[i];
            if (vah !== null && typicals[i] > vah) acceptedAbove[i] = (i > 0 ? acceptedAbove[i - 1] : 0) + 1;
            if (val !== null && typicals[i] < val) acceptedBelow[i] = (i > 0 ? acceptedBelow[i - 1] : 0) + 1;
        }

        const mask = buildPolymarket1sPressureAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [valueArea.vah, valueArea.val], (i) => {
            if (acceptedAbove[i] >= p.acceptanceBars && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Value area high acceptance with pressure agreement");
            }
            if (acceptedBelow[i] >= p.acceptanceBars && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Value area low acceptance with pressure agreement");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
        volume_profile_acceptance_pressure_agreement.executePrepared!(
            volume_profile_acceptance_pressure_agreement.prepareFinderData!(data),
            params,
            data,
            context
        ),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "acceptanceBars"],
    },
};
