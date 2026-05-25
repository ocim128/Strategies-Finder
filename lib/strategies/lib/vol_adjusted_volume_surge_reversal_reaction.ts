import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateATR } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sReactionAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

type VolAdjustedVolumeSurgeReversalReactionPrepared = {
    cleanData: OHLCVData[];
    highs: number[];
    lows: number[];
    closes: number[];
    typicals: number[];
    volumes: number[];
    averageByLookback: Map<number, (number | null)[]>;
    atrByLookback: Map<number, (number | null)[]>;
    volumeZByLookback: Map<number, (number | null)[]>;
};

function normalizeVolAdjustedVolumeSurgeReversalReactionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 35, 5),
        atrMultiplier: normalizeNumberParam(params.atrMultiplier, 2.0, 0.1),
        volZThreshold: normalizeNumberParam(params.volZThreshold, 1.6, 0),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
    };
}

function prepareVolAdjustedVolumeSurgeReversalReactionData(data: OHLCVData[]): VolAdjustedVolumeSurgeReversalReactionPrepared {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        highs: getHighs(cleanData),
        lows: getLows(cleanData),
        closes: getCloses(cleanData),
        typicals: getTypicalPrices(cleanData),
        volumes: getVolumes(cleanData),
        averageByLookback: new Map(),
        atrByLookback: new Map(),
        volumeZByLookback: new Map(),
    };
}

function getPreparedVolAdjustedVolumeSurgeReversalReactionData(
    preparedData: unknown,
    data: OHLCVData[]
): VolAdjustedVolumeSurgeReversalReactionPrepared {
    if (
        preparedData
        && typeof preparedData === "object"
        && "averageByLookback" in preparedData
        && "atrByLookback" in preparedData
        && "volumeZByLookback" in preparedData
    ) {
        return preparedData as VolAdjustedVolumeSurgeReversalReactionPrepared;
    }
    return prepareVolAdjustedVolumeSurgeReversalReactionData(data);
}

function getPreparedAverage(
    prepared: VolAdjustedVolumeSurgeReversalReactionPrepared,
    lookback: number
): (number | null)[] {
    let average = prepared.averageByLookback.get(lookback);
    if (!average) {
        average = buildRollingAverage(prepared.typicals, lookback);
        prepared.averageByLookback.set(lookback, average);
    }
    return average;
}

function getPreparedAtr(
    prepared: VolAdjustedVolumeSurgeReversalReactionPrepared,
    lookback: number
): (number | null)[] {
    let atr = prepared.atrByLookback.get(lookback);
    if (!atr) {
        atr = calculateATR(prepared.highs, prepared.lows, prepared.closes, lookback);
        prepared.atrByLookback.set(lookback, atr);
    }
    return atr;
}

function getPreparedVolumeZ(
    prepared: VolAdjustedVolumeSurgeReversalReactionPrepared,
    lookback: number
): (number | null)[] {
    let volumeZ = prepared.volumeZByLookback.get(lookback);
    if (!volumeZ) {
        volumeZ = buildRollingZScore(prepared.volumes, lookback);
        prepared.volumeZByLookback.set(lookback, volumeZ);
    }
    return volumeZ;
}

export const vol_adjusted_volume_surge_reversal_reaction: Strategy = {
    name: "Volatility-Adjusted Volume Surge Reversal with Reaction Agreement",
    description: "Fades ATR-adjusted volume-surge overextensions only when Polymarket reaction agreement allows the contrarian side.",
    defaultParams: {
        lookback: 35,
        atrMultiplier: 2.0,
        volZThreshold: 1.6,
        lagSec: 5,
    },
    paramLabels: {
        lookback: "Lookback",
        atrMultiplier: "ATR Multiplier",
        volZThreshold: "Volume Z-Score Threshold",
        lagSec: "Reaction Lag Seconds",
    },
    normalizeParams: normalizeVolAdjustedVolumeSurgeReversalReactionParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data) => prepareVolAdjustedVolumeSurgeReversalReactionData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedVolAdjustedVolumeSurgeReversalReactionData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeVolAdjustedVolumeSurgeReversalReactionParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = prepared.typicals;
        const average = getPreparedAverage(prepared, lookback);
        const atr = getPreparedAtr(prepared, lookback);
        const volumeZ = getPreparedVolumeZ(prepared, lookback);
        const mask = buildPolymarket1sReactionAgreementMask(cleanData, context, {
            volLookback: lookback,
            lagSec: p.lagSec,
        });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [average, atr, volumeZ], (i) => {
            const center = average[i];
            const range = atr[i];
            const volScore = volumeZ[i];
            if (center === null || range === null || volScore === null || volScore < p.volZThreshold) return null;

            if (typicals[i] < center - p.atrMultiplier * range && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Volume-surge downside overextension with reaction long agreement");
            }
            if (typicals[i] > center + p.atrMultiplier * range && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Volume-surge upside overextension with reaction short agreement");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
        vol_adjusted_volume_surge_reversal_reaction.executePrepared?.(
            prepareVolAdjustedVolumeSurgeReversalReactionData(data),
            params,
            data,
            context
        ) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "atrMultiplier", "volZThreshold", "lagSec"],
    },
};
