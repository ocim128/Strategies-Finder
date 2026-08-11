import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingSkewness } from "./price-action-statistics-core";

const SKEW_BAND = 1;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(20, Math.round(Number(params.lookback ?? 60))),
    };
}

export const positive_skew_lottery_fade: Strategy = {
    name: "Positive Skew Lottery Fade",
    description: "Fades return-skew extremes: sells right-tail lottery regimes and buys left-tail crash regimes on band-entry edges.",
    defaultParams: {
        lookback: 60,
    },
    paramLabels: {
        lookback: "Skew Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = buildRateOfChange(getCloses(cleanData), 1).map((v) => (v === null ? 0 : v));
        const skew = buildRollingSkewness(returns, lookback);

        // Band-state helpers treat a null (unmeasurable) value as outside the band,
        // so the first measurable in-band bar still counts as a band entry.
        const leftTail = (j: number): boolean => {
            const s = skew[j];
            return s !== null && s <= -SKEW_BAND;
        };
        const rightTail = (j: number): boolean => {
            const s = skew[j];
            return s !== null && s >= SKEW_BAND;
        };

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback) return null;
            if (skew[i] === null) return null;

            // Left-tail crash regime entered: skew falls through the oversold band.
            if (leftTail(i) && !leftTail(i - 1)) {
                return createBuySignal(cleanData, i, `Skew fade buy: skew ${skew[i]!.toFixed(2)} entered left-tail band`);
            }
            // Right-tail lottery regime entered: skew rises through the overbought band.
            if (rightTail(i) && !rightTail(i - 1)) {
                return createSellSignal(cleanData, i, `Skew fade sell: skew ${skew[i]!.toFixed(2)} entered right-tail band`);
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
