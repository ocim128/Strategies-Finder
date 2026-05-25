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

type RollingMinMaxFrame = ReturnType<typeof buildRollingMinMax>;

type MicroWickExhaustionExecutableAgreementPrepared = {
    cleanData: OHLCVData[];
    typicals: number[];
    volumes: number[];
    lowerWickRatio: number[];
    upperWickRatio: number[];
    boundaryByLookback: Map<number, RollingMinMaxFrame>;
    volumeZByLookback: Map<number, (number | null)[]>;
};

function normalizeMicroWickExhaustionExecutableAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        wickRatio: normalizeNumberParam(params.wickRatio, 0.68, 0, 1),
    };
}

function buildWickRatioSeries(data: OHLCVData[]): { lowerWickRatio: number[]; upperWickRatio: number[] } {
    const lowerWickRatio: number[] = new Array(data.length).fill(0);
    const upperWickRatio: number[] = new Array(data.length).fill(0);
    for (let i = 0; i < data.length; i++) {
        const metrics = computePriceActionBarMetrics(data[i]);
        if (metrics.range <= 0) continue;
        lowerWickRatio[i] = metrics.lowerWick / metrics.range;
        upperWickRatio[i] = metrics.upperWick / metrics.range;
    }
    return { lowerWickRatio, upperWickRatio };
}

function prepareMicroWickExhaustionExecutableAgreementData(
    data: OHLCVData[]
): MicroWickExhaustionExecutableAgreementPrepared {
    const cleanData = ensureCleanData(data);
    const wickRatios = buildWickRatioSeries(cleanData);
    return {
        cleanData,
        typicals: getTypicalPrices(cleanData),
        volumes: getVolumes(cleanData),
        lowerWickRatio: wickRatios.lowerWickRatio,
        upperWickRatio: wickRatios.upperWickRatio,
        boundaryByLookback: new Map<number, RollingMinMaxFrame>(),
        volumeZByLookback: new Map<number, (number | null)[]>(),
    };
}

function getPreparedMicroWickExhaustionExecutableAgreementData(
    preparedData: unknown,
    data: OHLCVData[]
): MicroWickExhaustionExecutableAgreementPrepared {
    if (
        preparedData
        && typeof preparedData === "object"
        && "lowerWickRatio" in preparedData
        && "upperWickRatio" in preparedData
        && "boundaryByLookback" in preparedData
        && "volumeZByLookback" in preparedData
    ) {
        return preparedData as MicroWickExhaustionExecutableAgreementPrepared;
    }
    return prepareMicroWickExhaustionExecutableAgreementData(data);
}

function getPreparedBoundary(
    prepared: MicroWickExhaustionExecutableAgreementPrepared,
    lookback: number
): RollingMinMaxFrame {
    let boundary = prepared.boundaryByLookback.get(lookback);
    if (!boundary) {
        boundary = buildRollingMinMax(prepared.typicals, lookback);
        prepared.boundaryByLookback.set(lookback, boundary);
    }
    return boundary;
}

function getPreparedVolumeZ(
    prepared: MicroWickExhaustionExecutableAgreementPrepared,
    lookback: number
): (number | null)[] {
    let volumeZ = prepared.volumeZByLookback.get(lookback);
    if (!volumeZ) {
        volumeZ = buildRollingZScore(prepared.volumes, lookback);
        prepared.volumeZByLookback.set(lookback, volumeZ);
    }
    return volumeZ;
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
    prepareFinderData: (data) => prepareMicroWickExhaustionExecutableAgreementData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedMicroWickExhaustionExecutableAgreementData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeMicroWickExhaustionExecutableAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const boundary = getPreparedBoundary(prepared, lookback);
        const volumeZ = getPreparedVolumeZ(prepared, lookback);
        const mask = buildPolymarket1sExecutableAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [boundary.min, boundary.max, volumeZ], (i) => {
            const low = boundary.min[i];
            const high = boundary.max[i];
            const volumeScore = volumeZ[i];
            if (low === null || high === null || volumeScore === null || volumeScore <= 1.2) return null;

            if (
                prepared.typicals[i] <= low
                && prepared.lowerWickRatio[i] >= p.wickRatio
                && mask.yesAllowed[i]
            ) {
                return createBuySignal(cleanData, i, "Lower-wick exhaustion at range low with executable YES agreement");
            }
            if (
                prepared.typicals[i] >= high
                && prepared.upperWickRatio[i] >= p.wickRatio
                && mask.noAllowed[i]
            ) {
                return createSellSignal(cleanData, i, "Upper-wick exhaustion at range high with executable NO agreement");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];
        return micro_wick_exhaustion_executable_agreement.executePrepared?.(
            prepareMicroWickExhaustionExecutableAgreementData(data),
            params,
            data,
            context
        ) ?? [];
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "wickRatio"],
    },
};
