import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";

const SLOW_WINDOW_MULTIPLE = 6;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 15))),
    };
}

export const multiscale_momentum_agreement: Strategy = {
    name: "Multiscale Momentum Agreement",
    description: "Trades time-series momentum only when the fast and fixed 6x slow horizons agree on direction, on fresh agreement.",
    defaultParams: {
        lookback: 15,
    },
    paramLabels: {
        lookback: "Fast Horizon",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const slowLookback = lookback * SLOW_WINDOW_MULTIPLE;
        if (cleanData.length < slowLookback + 1) return [];

        const closes = getCloses(cleanData);
        const rocFast = buildRateOfChange(closes, lookback);
        const rocSlow = buildRateOfChange(closes, slowLookback);

        // Agreement state; a null (unmeasurable) reading counts as no agreement,
        // so the first certified agreement bar registers as a fresh entry.
        const state = (j: number): { up: boolean; down: boolean } => {
            const fast = rocFast[j];
            const slow = rocSlow[j];
            if (fast === null || slow === null) return { up: false, down: false };
            return {
                up: fast > 0 && slow > 0,
                down: fast < 0 && slow < 0,
            };
        };

        return createSignalLoop(cleanData, [], (i) => {
            if (i < slowLookback) return null;
            const now = state(i);
            const prev = state(i - 1);

            if (now.up && !prev.up) {
                return createBuySignal(cleanData, i, `Multiscale momentum buy: fast ${rocFast[i]!.toFixed(4)}, slow ${rocSlow[i]!.toFixed(4)}`);
            }
            if (now.down && !prev.down) {
                return createSellSignal(cleanData, i, `Multiscale momentum sell: fast ${rocFast[i]!.toFixed(4)}, slow ${rocSlow[i]!.toFixed(4)}`);
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
