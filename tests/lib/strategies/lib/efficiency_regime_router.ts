import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildRollingMedian } from "./price-action-statistics-core";

function normalizeEfficiencyRegimeRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        efficiency_lookback: Math.max(2, Math.round(Number(params.efficiency_lookback ?? 55))),
        regime_threshold: Math.max(0, Math.min(1, Number(params.regime_threshold ?? 0.65))),
    };
}

export const efficiency_regime_router: Strategy = {
    name: "Efficiency Regime Router",
    description:
        "Routes high-efficiency regimes to rolling-median alignment and low-efficiency regimes to trailing-range boundary reversion.",
    defaultParams: {
        efficiency_lookback: 55,
        regime_threshold: 0.65,
    },
    paramLabels: {
        efficiency_lookback: "Efficiency Lookback",
        regime_threshold: "Regime Threshold",
    },
    normalizeParams: normalizeEfficiencyRegimeRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyRegimeRouterParams(params);
        const lookback = p.efficiency_lookback as number;
        const threshold = p.regime_threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const median = buildRollingMedian(closes, lookback);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);

        return createSignalLoop(cleanData, [efficiency, median, highest, lowest], (i) => {
            const er = efficiency[i];
            const med = median[i];
            const hi = highest[i];
            const lo = lowest[i];
            if (er === null || med === null || hi === null || lo === null) return null;

            if (er > threshold) {
                if (closes[i] > med) {
                    return createBuySignal(cleanData, i, `High efficiency ${er.toFixed(3)} above median`);
                }
                if (closes[i] < med) {
                    return createSellSignal(cleanData, i, `High efficiency ${er.toFixed(3)} below median`);
                }
                return null;
            }

            const range = hi - lo;
            if (range <= 0) return null;
            const position = (closes[i] - lo) / range;

            if (position <= 0.25) {
                return createBuySignal(cleanData, i, `Low efficiency range reversion from ${(position * 100).toFixed(0)}%`);
            }
            if (position >= 0.75) {
                return createSellSignal(cleanData, i, `Low efficiency range reversion from ${(position * 100).toFixed(0)}%`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["efficiency_lookback", "regime_threshold"],
    },
};
