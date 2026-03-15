import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateDonchianChannels } from "../indicators";
import { buildStreakCount } from "./price-action-statistics-core";
import { getPriceActionBarMetrics } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        donchPeriod: Math.max(2, Math.round(Number(params.donchPeriod ?? 20))),
        streakMin: Math.max(1, Math.round(Number(params.streakMin ?? 3))),
    };
}

export const donchian_wick_streak_trap: Strategy = {
	name: "Donchian Wick Streak Trap",
	description: "Wait for multiple consecutive bars that physically touch the outer Donchian extrema but each bar independently prints a massive rejection wick, proving a heavily defended institutional wall.",
	defaultParams: {
		donchPeriod: 20,
		streakMin: 3,
		wickPctMin: 0.5,
	},
	paramLabels: {
		donchPeriod: "Donchian Period",
		streakMin: "Streak Minimum",
		wickPctMin: "Wick Pct Minimum",
	},
    normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
        const normParams = normalizeParams(params);
		const period = normParams.donchPeriod as number;
		const reqStreak = normParams.streakMin as number;
		const wickPctMin = Number(params.wickPctMin ?? 0.5);

		if (cleanData.length < period) return [];

		const { upper, lower } = calculateDonchianChannels(
			cleanData.map(d => d.high),
			cleanData.map(d => d.low),
			period
		);

        const metricsCondition = cleanData.map(d => getPriceActionBarMetrics(d));

        const buyStreakCondition = cleanData.map((d, i) => {
            if (lower[i] === null || metricsCondition[i].lowerWick === null) return 0;
            const wickRatio = metricsCondition[i].range > 0 ? metricsCondition[i].lowerWick / metricsCondition[i].range : 0;
            return (d.low <= lower[i]!) && (wickRatio > wickPctMin) ? 1 : 0;
        });

        const sellStreakCondition = cleanData.map((d, i) => {
            if (upper[i] === null || metricsCondition[i].upperWick === null) return 0;
            const wickRatio = metricsCondition[i].range > 0 ? metricsCondition[i].upperWick / metricsCondition[i].range : 0;
            return (d.high >= upper[i]!) && (wickRatio > wickPctMin) ? -1 : 0;
        });

        const buyStreak = buildStreakCount(buyStreakCondition);
        const sellStreak = buildStreakCount(sellStreakCondition);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < period || buyStreak[i-1] === null || sellStreak[i-1] === null) return null;

            if (buyStreak[i-1]! >= reqStreak && cleanData[i].close > cleanData[i-1].high) {
                return createBuySignal(cleanData, i, "Donchian floor defense swept into long trigger");
            }

            if (sellStreak[i-1]! >= reqStreak && cleanData[i].close < cleanData[i-1].close) {
                return createSellSignal(cleanData, i, "Donchian ceiling defense swept into short trigger");
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["donchPeriod", "streakMin", "wickPctMin"],
	},
};
