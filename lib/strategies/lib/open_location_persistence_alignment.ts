import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getHighs,
    getLows,
    getOpens,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeOpenLocationPersistenceAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const open_location_persistence_alignment: Strategy = {
    name: "Open Location Persistence Alignment",
    description: "Aligns with sustained demand or supply when the rolling median open location and the current close location agree.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeOpenLocationPersistenceAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeOpenLocationPersistenceAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const opens = getOpens(cleanData);
        const lows = getLows(cleanData);
        const highs = getHighs(cleanData);
        const openLocation: number[] = new Array(cleanData.length);
        for (let i = 0; i < cleanData.length; i++) {
            const range = highs[i] - lows[i];
            openLocation[i] = range > 0 ? (opens[i] - lows[i]) / range : 0.5;
        }
        const medianOpenLocation = buildRollingMedian(openLocation, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [medianOpenLocation], (i) => {
            if (i < lookback) return null;
            const medianOpen = medianOpenLocation[i];
            if (medianOpen === null) return null;

            if (medianOpen < 0.4 && closeLocation[i] > 0.6) {
                return createBuySignal(cleanData, i, `Low median open location ${medianOpen.toFixed(2)} with strong close ${closeLocation[i].toFixed(2)}`);
            }
            if (medianOpen > 0.6 && closeLocation[i] < 0.4) {
                return createSellSignal(cleanData, i, `High median open location ${medianOpen.toFixed(2)} with weak close ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
