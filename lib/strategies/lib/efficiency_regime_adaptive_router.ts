import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingMedian, buildRollingZScore } from "./price-action-statistics-core";

const REGIME_SPLIT = 0.4;
const CHOP_Z_BAND = 2.0;

function normalizeEfficiencyRegimeAdaptiveRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const efficiency_regime_adaptive_router: Strategy = {
    name: "Efficiency Regime Adaptive Router",
    description: "Routes close z-score reversion to low-efficiency chop and rolling-median crosses to high-efficiency trends, splitting trades by regime.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeEfficiencyRegimeAdaptiveRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeEfficiencyRegimeAdaptiveRouterParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const z = buildRollingZScore(closes, lookback);
        const medians = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [efficiency, z], (i) => {
            if (i < lookback) return null;
            const eff = efficiency[i];
            const zScore = z[i];
            const medianNow = medians[i];
            const medianPrev = medians[i - 1];
            if (eff === null || zScore === null || medianNow === null || medianPrev === null) return null;

            if (eff < REGIME_SPLIT && zScore < -CHOP_Z_BAND) {
                return createBuySignal(cleanData, i, `Chop reversion buy: eff ${eff.toFixed(2)}, close z ${zScore.toFixed(2)}`);
            }
            if (eff < REGIME_SPLIT && zScore > CHOP_Z_BAND) {
                return createSellSignal(cleanData, i, `Chop reversion sell: eff ${eff.toFixed(2)}, close z ${zScore.toFixed(2)}`);
            }
            if (eff >= REGIME_SPLIT && closes[i - 1] <= medianPrev && closes[i] > medianNow) {
                return createBuySignal(cleanData, i, `Trend momentum buy: eff ${eff.toFixed(2)}, median cross up`);
            }
            if (eff >= REGIME_SPLIT && closes[i - 1] >= medianPrev && closes[i] < medianNow) {
                return createSellSignal(cleanData, i, `Trend momentum sell: eff ${eff.toFixed(2)}, median cross down`);
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
