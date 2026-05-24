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
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVwTypicalDispersionNoAdverseParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const typicals = getTypicalPrices(cleanData);
        const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
        const dispersion = buildVolumeWeightedTypicalDispersion(typicals, volumes, lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [vwap, dispersion], (i) => {
            const center = vwap[i];
            const width = dispersion[i];
            if (center === null || width === null || width <= 0) return null;

            if (typicals[i] <= center - p.threshold * width && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Typical price below volume-weighted dispersion with no adverse YES mask");
            }
            if (typicals[i] >= center + p.threshold * width && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Typical price above volume-weighted dispersion with no adverse NO mask");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold"],
    },
};
