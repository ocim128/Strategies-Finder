import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, extractBarMetricSeries } from "./price-action-statistics-core";

function buildRollingSum(values: number[], lookbackInput: number): (number | null)[] {
    const lookback = Math.max(1, Math.round(lookbackInput));
    const result: (number | null)[] = new Array(values.length).fill(null);
    let sum = 0;

    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= lookback) {
            sum -= values[i - lookback];
        }
        if (i >= lookback - 1) {
            result[i] = sum;
        }
    }

    return result;
}

function normalizeCumulativeGapSettlementAnchorParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
    };
}

export const cumulative_gap_settlement_anchor: Strategy = {
    name: "Cumulative Gap Settlement Anchor",
    description:
        "Tracks rolling net gap displacement and only enters when settlement agrees with the same rolling median side.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeCumulativeGapSettlementAnchorParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCumulativeGapSettlementAnchorParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const gapBias = buildRollingSum(extractBarMetricSeries(cleanData, "gapPct"), lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [gapBias, median], (i) => {
            const bias = gapBias[i];
            const med = median[i];
            if (bias === null || med === null) return null;

            if (bias > 0 && closes[i] > med) {
                return createBuySignal(cleanData, i, `Positive cumulative gap bias ${bias.toFixed(3)}`);
            }
            if (bias < 0 && closes[i] < med) {
                return createSellSignal(cleanData, i, `Negative cumulative gap bias ${bias.toFixed(3)}`);
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
