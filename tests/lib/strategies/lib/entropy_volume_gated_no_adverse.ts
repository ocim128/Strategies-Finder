import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingEntropy, buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sNoAdverseActionableMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const ENTROPY_BINS = 5;
const MAX_ENTROPY = Math.log2(ENTROPY_BINS);

type EntropyVolumeGatedNoAdversePrepared = {
    cleanData: OHLCVData[];
    closes: number[];
    volumes: number[];
    returns: number[];
    entropyByLookback: Map<number, (number | null)[]>;
    volumeZByLookback: Map<number, (number | null)[]>;
    averageByLookback: Map<number, (number | null)[]>;
};

function normalizeEntropyVolumeGatedNoAdverseParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        entropyThreshold: normalizeNumberParam(params.entropyThreshold, 0.45, 0, 1),
    };
}

function buildLogReturnSeries(closes: number[]): number[] {
    const returns = new Array<number>(closes.length).fill(0);
    for (let i = 1; i < closes.length; i++) {
        if (closes[i - 1] > 0) {
            returns[i] = Math.log(closes[i] / closes[i - 1]);
        }
    }
    return returns;
}

function prepareEntropyVolumeGatedNoAdverseData(data: OHLCVData[]): EntropyVolumeGatedNoAdversePrepared {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    return {
        cleanData,
        closes,
        volumes: getVolumes(cleanData),
        returns: buildLogReturnSeries(closes),
        entropyByLookback: new Map<number, (number | null)[]>(),
        volumeZByLookback: new Map<number, (number | null)[]>(),
        averageByLookback: new Map<number, (number | null)[]>(),
    };
}

function getPreparedEntropyVolumeGatedNoAdverseData(
    preparedData: unknown,
    data: OHLCVData[]
): EntropyVolumeGatedNoAdversePrepared {
    if (
        preparedData
        && typeof preparedData === "object"
        && "returns" in preparedData
        && "entropyByLookback" in preparedData
        && "averageByLookback" in preparedData
    ) {
        return preparedData as EntropyVolumeGatedNoAdversePrepared;
    }
    return prepareEntropyVolumeGatedNoAdverseData(data);
}

function getPreparedEntropy(
    prepared: EntropyVolumeGatedNoAdversePrepared,
    lookback: number
): (number | null)[] {
    let entropy = prepared.entropyByLookback.get(lookback);
    if (!entropy) {
        entropy = buildRollingEntropy(prepared.returns, lookback, ENTROPY_BINS);
        prepared.entropyByLookback.set(lookback, entropy);
    }
    return entropy;
}

function getPreparedVolumeZ(
    prepared: EntropyVolumeGatedNoAdversePrepared,
    lookback: number
): (number | null)[] {
    let volumeZ = prepared.volumeZByLookback.get(lookback);
    if (!volumeZ) {
        volumeZ = buildRollingZScore(prepared.volumes, lookback);
        prepared.volumeZByLookback.set(lookback, volumeZ);
    }
    return volumeZ;
}

function getPreparedAverage(
    prepared: EntropyVolumeGatedNoAdversePrepared,
    lookback: number
): (number | null)[] {
    let average = prepared.averageByLookback.get(lookback);
    if (!average) {
        average = buildRollingAverage(prepared.closes, lookback);
        prepared.averageByLookback.set(lookback, average);
    }
    return average;
}

export const entropy_volume_gated_no_adverse: Strategy = {
    name: "Entropy Volume Gated with No Adverse Mask",
    description: "Trades low-entropy high-volume directional transitions only when the Polymarket side is actionable and non-adverse.",
    defaultParams: {
        lookback: 25,
        entropyThreshold: 0.45,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyThreshold: "Maximum Normalized Entropy",
    },
    normalizeParams: normalizeEntropyVolumeGatedNoAdverseParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data) => prepareEntropyVolumeGatedNoAdverseData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedEntropyVolumeGatedNoAdverseData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeEntropyVolumeGatedNoAdverseParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const entropy = getPreparedEntropy(prepared, lookback);
        const volumeZ = getPreparedVolumeZ(prepared, lookback);
        const average = getPreparedAverage(prepared, lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [entropy, volumeZ, average], (i) => {
            const entropyValue = entropy[i];
            const volumeScore = volumeZ[i];
            const center = average[i];
            if (entropyValue === null || volumeScore === null || center === null) return null;
            if ((entropyValue / MAX_ENTROPY) > p.entropyThreshold || volumeScore <= 0) return null;

            if (prepared.closes[i] > center && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Low entropy high-volume transition above average with no adverse YES mask");
            }
            if (prepared.closes[i] < center && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Low entropy high-volume transition below average with no adverse NO mask");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];
        return entropy_volume_gated_no_adverse.executePrepared?.(
            prepareEntropyVolumeGatedNoAdverseData(data),
            params,
            data,
            context
        ) ?? [];
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyThreshold"],
    },
};
