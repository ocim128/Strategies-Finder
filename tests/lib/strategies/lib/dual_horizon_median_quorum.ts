import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeDualHorizonMedianQuorumParams(params: StrategyParams): StrategyParams {
    const fastLookback = Math.max(2, Math.round(Number(params.fast_lookback ?? 21)));
    const slowLookback = Math.max(fastLookback + 1, Math.round(Number(params.slow_lookback ?? 126)));
    return {
        ...params,
        fast_lookback: fastLookback,
        slow_lookback: slowLookback,
    };
}

export const dual_horizon_median_quorum: Strategy = {
    name: "Dual Horizon Median Quorum",
    description:
        "Requires price to agree with both intermediate and long-horizon rolling medians before taking directional entries.",
    defaultParams: {
        fast_lookback: 21,
        slow_lookback: 126,
    },
    paramLabels: {
        fast_lookback: "Fast Lookback",
        slow_lookback: "Slow Lookback",
    },
    normalizeParams: normalizeDualHorizonMedianQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDualHorizonMedianQuorumParams(params);
        const slowLookback = p.slow_lookback as number;
        if (cleanData.length < slowLookback) return [];

        const closes = getCloses(cleanData);
        const fastMedian = buildRollingMedian(closes, p.fast_lookback as number);
        const slowMedian = buildRollingMedian(closes, slowLookback);

        return createSignalLoop(cleanData, [fastMedian, slowMedian], (i) => {
            const fast = fastMedian[i];
            const slow = slowMedian[i];
            if (fast === null || slow === null) return null;

            if (closes[i] > fast && closes[i] > slow) {
                return createBuySignal(cleanData, i, "Close above fast and slow medians");
            }
            if (closes[i] < fast && closes[i] < slow) {
                return createSellSignal(cleanData, i, "Close below fast and slow medians");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fast_lookback", "slow_lookback"],
    },
};
