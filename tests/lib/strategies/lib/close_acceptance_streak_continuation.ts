import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
		streakLen: Math.max(2, Math.round(Number(params.streakLen ?? 4))),
	};
}

export const close_acceptance_streak_continuation: Strategy = {
	name: "Close Acceptance Streak Continuation",
	description: "Enters in the direction of a persistent trend when the ratio consistently closes outside the midpoint of its previous bars.",
	defaultParams: {
		lookback: 20,
		streakLen: 4,
	},
	paramLabels: {
		lookback: "Warmup Lookback",
		streakLen: "Required Streak Length",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const streakLen = p.streakLen as number;
		if (cleanData.length < lookback) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const flags = acceptance.map(v => v > 0.5 ? 1 : v < -0.5 ? -1 : 0);
		const streaks = buildStreakCount(flags);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < lookback) return null;
			const currentStreak = streaks[i];

			if (currentStreak >= streakLen) {
				return createBuySignal(cleanData, i, `Bullish close acceptance streak reached (${currentStreak} consecutive bars > 0.5)`);
			}
			if (currentStreak <= -streakLen) {
				return createSellSignal(cleanData, i, `Bearish close acceptance streak reached (${currentStreak} consecutive bars < -0.5)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "streakLen"],
	},
};
