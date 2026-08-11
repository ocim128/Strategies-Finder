import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

const EXTREME_Z = 2.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
    lookback: Math.max(8, Math.round(Number(params.lookback ?? 20))),
    };
}

export const extreme_move_reversal_fade: Strategy = {
    name: "Extreme Move Reversal Fade",
    description: "Fades extreme multi-bar moves only when the current bar closes against them, confirming the reversal has begun.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Move & Z Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const roc = buildRateOfChange(getCloses(cleanData), lookback).map((v) => (v === null ? 0 : v));
        const z = buildRollingZScore(roc, lookback);

        return createSignalLoop(cleanData, [z], (i) => {
            const score = z[i];
            if (score === null) return null;

            // Extreme down move, then a bullish reversal bar: the fade is confirmed.
            if (score <= -EXTREME_Z && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Extreme reversal buy: move z ${score.toFixed(2)} with bullish reversal bar`);
            }
            if (score >= EXTREME_Z && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Extreme reversal sell: move z ${score.toFixed(2)} with bearish reversal bar`);
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
