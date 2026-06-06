import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateVWAP } from "../indicators";
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
import { buildPolymarket1sNoAdverseActionableMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

type VwTypicalDispersionNoAdversePrepared = {
    cleanData: OHLCVData[];
    highs: number[];
    lows: number[];
    closes: number[];
    volumes: number[];
    typicals: number[];
    vwapByLookback: Map<number, (number | null)[]>;
    dispersionByLookback: Map<number, (number | null)[]>;
};

function buildVolumeWeightedTypicalDispersion(
    typicals: number[],
    volumes: number[],
    lookbackInput: number
): (number | null)[] {
    const lookback = Math.max(2, Math.round(lookbackInput));
    const result: (number | null)[] = new Array(typicals.length).fill(null);
    let sumVolume = 0;
    let sumPriceVolume = 0;
    let sumPriceSquaredVolume = 0;

    for (let i = 0; i < typicals.length; i++) {
        const volume = Math.max(0, volumes[i]);
        const typical = typicals[i];
        sumVolume += volume;
        sumPriceVolume += typical * volume;
        sumPriceSquaredVolume += typical * typical * volume;

        if (i >= lookback) {
            const oldVolume = Math.max(0, volumes[i - lookback]);
            const oldTypical = typicals[i - lookback];
            sumVolume -= oldVolume;
            sumPriceVolume -= oldTypical * oldVolume;
            sumPriceSquaredVolume -= oldTypical * oldTypical * oldVolume;
        }

        if (i < lookback - 1 || sumVolume <= 0) continue;
        const mean = sumPriceVolume / sumVolume;
        const variance = Math.max(0, sumPriceSquaredVolume / sumVolume - mean * mean);
        result[i] = Math.sqrt(variance);
    }

    return result;
}

function normalizeVwTypicalDispersionNoAdverseParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 35, 5),
        threshold: normalizeNumberParam(params.threshold, 2.2, 0.1),
    };
}

function prepareVwTypicalDispersionNoAdverseData(data: OHLCVData[]): VwTypicalDispersionNoAdversePrepared {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        highs: getHighs(cleanData),
        lows: getLows(cleanData),
        closes: getCloses(cleanData),
        volumes: getVolumes(cleanData),
        typicals: getTypicalPrices(cleanData),
        vwapByLookback: new Map<number, (number | null)[]>(),
        dispersionByLookback: new Map<number, (number | null)[]>(),
    };
}

function getPreparedVwTypicalDispersionNoAdverseData(
    preparedData: unknown,
    data: OHLCVData[]
): VwTypicalDispersionNoAdversePrepared {
    if (
        preparedData
        && typeof preparedData === "object"
        && "typicals" in preparedData
        && "vwapByLookback" in preparedData
        && "dispersionByLookback" in preparedData
    ) {
        return preparedData as VwTypicalDispersionNoAdversePrepared;
    }
    return prepareVwTypicalDispersionNoAdverseData(data);
}

function getPreparedVwap(
    prepared: VwTypicalDispersionNoAdversePrepared,
    lookback: number
): (number | null)[] {
    let vwap = prepared.vwapByLookback.get(lookback);
    if (!vwap) {
        vwap = calculateVWAP(prepared.highs, prepared.lows, prepared.closes, prepared.volumes, lookback);
        prepared.vwapByLookback.set(lookback, vwap);
    }
    return vwap;
}

function getPreparedDispersion(
    prepared: VwTypicalDispersionNoAdversePrepared,
    lookback: number
): (number | null)[] {
    let dispersion = prepared.dispersionByLookback.get(lookback);
    if (!dispersion) {
        dispersion = buildVolumeWeightedTypicalDispersion(prepared.typicals, prepared.volumes, lookback);
        prepared.dispersionByLookback.set(lookback, dispersion);
    }
    return dispersion;
}

export const vw_typical_dispersion_no_adverse: Strategy = {
    name: "Volume-Weighted Typical Dispersion with No Adverse Mask",
    description: "Fades typical-price deviations from rolling VWAP only when Polymarket no-adverse actionability allows the side.",
    defaultParams: {
        lookback: 35,
        threshold: 2.2,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Dispersion Multiplier",
    },
    normalizeParams: normalizeVwTypicalDispersionNoAdverseParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data) => prepareVwTypicalDispersionNoAdverseData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedVwTypicalDispersionNoAdverseData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeVwTypicalDispersionNoAdverseParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const vwap = getPreparedVwap(prepared, lookback);
        const dispersion = getPreparedDispersion(prepared, lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [vwap, dispersion], (i) => {
            const center = vwap[i];
            const width = dispersion[i];
            if (center === null || width === null || width <= 0) return null;

            if (prepared.typicals[i] <= center - p.threshold * width && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Typical price below volume-weighted dispersion with no adverse YES mask");
            }
            if (prepared.typicals[i] >= center + p.threshold * width && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Typical price above volume-weighted dispersion with no adverse NO mask");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];
        return vw_typical_dispersion_no_adverse.executePrepared?.(
            prepareVwTypicalDispersionNoAdverseData(data),
            params,
            data,
            context
        ) ?? [];
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold"],
    },
};
