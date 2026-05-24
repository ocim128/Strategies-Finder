import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildStreakCount } from "./price-action-statistics-core";
import { buildPolymarket1sGammaConsensusMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam } from "./range-conviction-core";

const MIN_EFFICIENCY = 0.6;

function normalizeEfficiencyStreakGammaConsensusParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        streakLength: normalizeIntegerParam(params.streakLength, 5, 2),
        volLookback: normalizeIntegerParam(params.volLookback, 40, 5),
    };
}

export const efficiency_streak_gamma_consensus: Strategy = {
    name: "Efficiency Streak with Gamma Consensus",
    description: "Joins high-efficiency close-return streaks only when Polymarket Gamma consensus agrees with the side.",
    defaultParams: {
        lookback: 30,
        streakLength: 5,
        volLookback: 40,
    },
    paramLabels: {
        lookback: "Efficiency Lookback",
        streakLength: "Streak Length",
        volLookback: "Gamma Volatility Lookback",
    },
    normalizeParams: normalizeEfficiencyStreakGammaConsensusParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyStreakGammaConsensusParams(params);
        if (cleanData.length < Math.max(p.lookback, p.volLookback) + p.streakLength + 1) return [];

        const closes = getCloses(cleanData);
        const flags = closes.map((close, i) => {
            if (i === 0) return 0;
            if (close > closes[i - 1]) return 1;
            if (close < closes[i - 1]) return -1;
            return 0;
        });
        const streak = buildStreakCount(flags);
        const efficiency = buildEfficiencyRatio(cleanData, p.lookback);
        const mask = buildPolymarket1sGammaConsensusMask(cleanData, context, { volLookback: p.volLookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [efficiency], (i) => {
            const er = efficiency[i];
            if (er === null || er < MIN_EFFICIENCY) return null;

            if (streak[i] >= p.streakLength && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "High-efficiency bullish streak with Gamma consensus");
            }
            if (streak[i] <= -p.streakLength && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "High-efficiency bearish streak with Gamma consensus");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "streakLength", "volLookback"],
    },
};
