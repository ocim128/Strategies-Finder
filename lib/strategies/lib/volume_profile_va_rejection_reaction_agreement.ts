import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    getCloses,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sReactionAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import {
    getPreparedValueAreaData,
    getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeVolumeProfileVaRejectionReactionAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 50, 5),
        volZThreshold: normalizeNumberParam(params.volZThreshold, 1.5, 0),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
    };
}

export const volume_profile_va_rejection_reaction_agreement: Strategy = {
    name: "Volume Profile Value Area Rejection with Reaction Agreement",
    description: "Fades high-volume value-area boundary rejections only when Polymarket reaction agreement allows the reversion side.",
    defaultParams: {
        lookback: 50,
        volZThreshold: 1.5,
        lagSec: 5,
    },
    paramLabels: {
        lookback: "Value Area Lookback",
        volZThreshold: "Volume Z-Score Threshold",
        lagSec: "Reaction Lag Seconds",
    },
    normalizeParams: normalizeVolumeProfileVaRejectionReactionAgreementParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedValueAreaData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeVolumeProfileVaRejectionReactionAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const typicals = getTypicalPrices(cleanData);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), lookback);
        const valueArea = getValueAreaSeries(prepared, lookback, 0.68, 12);
        const mask = buildPolymarket1sReactionAgreementMask(cleanData, context, {
            volLookback: lookback,
            lagSec: p.lagSec,
        });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [valueArea.vah, valueArea.val, volumeZ], (i) => {
            const vah = valueArea.vah[i];
            const val = valueArea.val[i];
            const volScore = volumeZ[i];
            if (vah === null || val === null || volScore === null || volScore < p.volZThreshold) return null;

            if (typicals[i] < val && closes[i] > val && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "High-volume value-area low rejection with reaction agreement");
            }
            if (typicals[i] > vah && closes[i] < vah && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "High-volume value-area high rejection with reaction agreement");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
        volume_profile_va_rejection_reaction_agreement.executePrepared!(
            volume_profile_va_rejection_reaction_agreement.prepareFinderData!(data),
            params,
            data,
            context
        ),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volZThreshold", "lagSec"],
    },
};
