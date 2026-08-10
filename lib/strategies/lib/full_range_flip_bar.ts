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

function normalizeFullRangeFlipBarParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        flipBand: Math.max(0.6, Math.min(0.95, Number(params.flipBand ?? 0.8))),
    };
}

export const full_range_flip_bar: Strategy = {
    name: "Full Range Flip Bar",
    description: "Follows bars that open near one extreme of their range and close beyond the magic band on the opposite side.",
    defaultParams: {
        flipBand: 0.8,
    },
    paramLabels: {
        flipBand: "Flip Band",
    },
    normalizeParams: normalizeFullRangeFlipBarParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeFullRangeFlipBarParams(params);
        const flipBand = p.flipBand as number;
        if (cleanData.length < 2) return [];

        const opens = getOpens(cleanData);
        const lows = getLows(cleanData);
        const highs = getHighs(cleanData);
        const openLocation: number[] = new Array(cleanData.length);
        for (let i = 0; i < cleanData.length; i++) {
            const range = highs[i] - lows[i];
            openLocation[i] = range > 0 ? (opens[i] - lows[i]) / range : 0.5;
        }
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (openLocation[i] <= 1 - flipBand && closeLocation[i] >= flipBand) {
                return createBuySignal(cleanData, i, `Full-range flip: open at ${openLocation[i].toFixed(2)} closed at ${closeLocation[i].toFixed(2)}`);
            }
            if (openLocation[i] >= flipBand && closeLocation[i] <= 1 - flipBand) {
                return createSellSignal(cleanData, i, `Full-range flip: open at ${openLocation[i].toFixed(2)} closed at ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["flipBand"],
    },
};
