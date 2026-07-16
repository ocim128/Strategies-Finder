import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 100))),
		streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 6))),
	};
}

export const streak_exhaustion_reversion: Strategy = {
	name: "Streak Exhaustion Reversion",
	description: "Fades prolonged directional close streaks (equal to or greater than streakThreshold) when the current bar closes in the opposite direction.",
	defaultParams: {
		lookback: 100,
		streakThreshold: 6,
	},
	paramLabels: {
		lookback: "Lookback Window",
		streakThreshold: "Streak Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const streakThreshold = p.streakThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < Math.max(lookback, streakThreshold) + 2) return [];

		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");

		const flags = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			const r = returns[j];
			flags[j] = r > 0 ? 1 : (r < 0 ? -1 : 0);
		}

		const streaks = buildStreakCount(flags);

		return createSignalLoop(cleanData, [streaks], (i) => {
			if (i < 1) return null;

			const prevStreak = streaks[i - 1];
			const currentReturn = returns[i];

			// Buy: consecutive bearish close streak is >= streakThreshold, and current close is positive
			if (prevStreak <= -streakThreshold && currentReturn > 0) {
				return createBuySignal(cleanData, i, `Streak exhaustion buy: prev bearish streak ${prevStreak}, current positive close`);
			}
			// Sell: consecutive bullish close streak is >= streakThreshold, and current close is negative
			if (prevStreak >= streakThreshold && currentReturn < 0) {
				return createSellSignal(cleanData, i, `Streak exhaustion sell: prev bullish streak ${prevStreak}, current negative close`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		streak_exhaustion_reversion.executePrepared!(
			streak_exhaustion_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "streakThreshold"],
	},
};
