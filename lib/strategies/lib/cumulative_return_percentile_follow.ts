import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

const IGNITION_HIGH = 0.85;
const IGNITION_LOW = 0.15;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 20))),
    };
}

export const cumulative_return_percentile_follow: Strategy = {
    name: "Cumulative Return Percentile Follow",
    description: "Follows momentum ignition when the lookback-bar return breaks into its own top or bottom return percentile.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Return Horizon",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        // Leading nulls are coerced so the percentile series is dense; the
        // coerced prefix reads as zero returns, which cannot cross the bands.
        const roc = buildRateOfChange(getCloses(cleanData), lookback).map((v) => (v === null ? 0 : v));
        const rank = buildPercentileRank(roc, lookback);

        return createSignalLoop(cleanData, [rank], (i) => {
            const prev = rank[i - 1];
            const curr = rank[i];
            if (curr === null) return null;

            // Crossing the top band: an unmeasurable previous rank counts as
            // not-active, so the first certified ignition registers fresh.
            if ((prev === null || prev <= IGNITION_HIGH) && curr > IGNITION_HIGH) {
                return createBuySignal(cleanData, i, `Percentile ignition buy: rank ${curr.toFixed(3)} crossed above ${IGNITION_HIGH}`);
            }
            if ((prev === null || prev >= IGNITION_LOW) && curr < IGNITION_LOW) {
                return createSellSignal(cleanData, i, `Percentile ignition sell: rank ${curr.toFixed(3)} crossed below ${IGNITION_LOW}`);
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
