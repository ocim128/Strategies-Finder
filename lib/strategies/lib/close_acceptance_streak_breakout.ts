import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
		streakLength: Math.max(2, Math.round(Number(params.streakLength ?? 3))),
	};
}

export const close_acceptance_streak_breakout: Strategy = {
	name: "Close Acceptance Streak Breakout",
	description: "Follows breakouts when the ratio close consistently accepts near the extremes of the bar range for a consecutive streak of bars.",
	defaultParams: {
		lookback: 20,
		streakLength: 3,
	},
	paramLabels: {
		lookback: "Warmup Lookback",
		streakLength: "Required Streak Length",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const streakLength = p.streakLength as number;
		if (cleanData.length < lookback) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const flags = acceptance.map(v => v > 0.60 ? 1 : v < -0.60 ? -1 : 0);
		const streaks = buildStreakCount(flags);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < lookback) return null;
			const currentStreak = streaks[i];

			if (currentStreak >= streakLength) {
				return createBuySignal(cleanData, i, `Bullish close acceptance streak breakout (${currentStreak} bars > 0.60)`);
			}
			if (currentStreak <= -streakLength) {
				return createSellSignal(cleanData, i, `Bearish close acceptance streak breakout (${currentStreak} bars < -0.60)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "streakLength"],
	},
};
