import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingMedian } from "./price-action-statistics-core";

function normalizeDualEfficiencyMomentumQuorumParams(params: StrategyParams): StrategyParams {
    const fastLookback = Math.max(2, Math.round(Number(params.fast_lookback ?? 20)));
    const slowLookback = Math.max(fastLookback + 1, Math.round(Number(params.slow_lookback ?? 63)));
    return {
        ...params,
        fast_lookback: fastLookback,
        slow_lookback: slowLookback,
        er_threshold: Math.max(0, Math.min(1, Number(params.er_threshold ?? 0.5))),
    };
}

export const dual_efficiency_momentum_quorum: Strategy = {
    name: "Dual Efficiency Momentum Quorum",
    description:
        "Requires fast and slow efficiency ratios to clear the same threshold before following median-relative trend direction.",
    defaultParams: {
        fast_lookback: 20,
        slow_lookback: 63,
        er_threshold: 0.5,
    },
    paramLabels: {
        fast_lookback: "Fast Lookback",
        slow_lookback: "Slow Lookback",
        er_threshold: "ER Threshold",
    },
    normalizeParams: normalizeDualEfficiencyMomentumQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDualEfficiencyMomentumQuorumParams(params);
        const fastLookback = p.fast_lookback as number;
        const slowLookback = p.slow_lookback as number;
        const threshold = p.er_threshold as number;
        if (cleanData.length < slowLookback + 1) return [];

        const closes = getCloses(cleanData);
        const fastEfficiency = buildEfficiencyRatio(cleanData, fastLookback);
        const slowEfficiency = buildEfficiencyRatio(cleanData, slowLookback);
        const fastMedian = buildRollingMedian(closes, fastLookback);
        const slowMedian = buildRollingMedian(closes, slowLookback);

        return createSignalLoop(cleanData, [fastEfficiency, slowEfficiency, fastMedian, slowMedian], (i) => {
            const fastEr = fastEfficiency[i];
            const slowEr = slowEfficiency[i];
            const fast = fastMedian[i];
            const slow = slowMedian[i];
            if (fastEr === null || slowEr === null || fast === null || slow === null) return null;
            if (fastEr <= threshold || slowEr <= threshold) return null;

            if (closes[i] > fast && closes[i] > slow) {
                return createBuySignal(cleanData, i, `Dual efficiency long fast=${fastEr.toFixed(2)} slow=${slowEr.toFixed(2)}`);
            }
            if (closes[i] < fast && closes[i] < slow) {
                return createSellSignal(cleanData, i, `Dual efficiency short fast=${fastEr.toFixed(2)} slow=${slowEr.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fast_lookback", "slow_lookback", "er_threshold"],
    },
};
