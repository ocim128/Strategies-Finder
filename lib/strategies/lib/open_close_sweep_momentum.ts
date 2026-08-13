import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getOpens,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

const HIGH_SWEEP_PCT = 0.9;
const LOW_SWEEP_PCT = 0.1;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const open_close_sweep_momentum: Strategy = {
    name: "Open Close Sweep Momentum",
    description: "Follows rare full-range sweeps, measured as close location minus open location at a percentile extreme.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Sweep Percentile Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const opens = getOpens(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const sweep = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const range = highs[i] - lows[i];
            const openLocation = range > 0 ? (opens[i] - lows[i]) / range : 0.5;
            const closeLocation = range > 0 ? (closes[i] - lows[i]) / range : 0.5;
            sweep[i] = Math.max(-1, Math.min(1, closeLocation - openLocation));
        }
        const pct = buildPercentileRank(sweep, lookback);

        return createSignalLoop(cleanData, [pct], (i) => {
            const pr = pct[i];
            if (pr === null) return null;

            if (pr >= HIGH_SWEEP_PCT && closes[i] > opens[i]) {
                return createBuySignal(cleanData, i, `Rare upward sweep: rank ${pr.toFixed(2)}`);
            }
            if (pr <= LOW_SWEEP_PCT && closes[i] < opens[i]) {
                return createSellSignal(cleanData, i, `Rare downward sweep: rank ${pr.toFixed(2)}`);
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
