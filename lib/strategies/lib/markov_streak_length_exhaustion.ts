import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildStreakCount, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(Number(params.lookback ?? 60))),
		maxExtensionProbability: Math.max(0.01, Math.min(1, Number(params.maxExtensionProbability ?? 0.2))),
	};
}

export const markov_streak_length_exhaustion: Strategy = {
	name: "Markov Streak Length Exhaustion",
	description: "Fades directional close streaks when the empirical Markov transition probability of extending the streak falls below a critical threshold.",
	defaultParams: {
		lookback: 60,
		maxExtensionProbability: 0.2,
	},
	paramLabels: {
		lookback: "Lookback Window",
		maxExtensionProbability: "Max Extension Prob",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const maxExtensionProbability = p.maxExtensionProbability as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		// Calculate directional streaks of close returns
		const flags = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			const ret = returns[j];
			flags[j] = ret > 0 ? 1 : (ret < 0 ? -1 : 0);
		}
		const streaks = buildStreakCount(flags);

		return createSignalLoop(cleanData, [zscore], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			if (z === null) return null;

			const currentStreak = streaks[i];
			if (currentStreak === 0) return null;

			const start = i - lookback + 1;
			const end = i - 1;

			if (currentStreak < 0) {
				// We are in a negative streak. Let N = Math.abs(currentStreak)
				// We want P(streak of len N -> streak of len N+1), i.e., transitioning from -N -> -(N+1)
				const N = Math.abs(currentStreak);
				let countN = 0;
				let countNToNPlus1 = 0;

				for (let j = start; j <= end; j++) {
					if (streaks[j] === -N) {
						countN++;
						if (streaks[j + 1] === -(N + 1)) {
							countNToNPlus1++;
						}
					}
				}

				const prob = countN > 0 ? countNToNPlus1 / countN : 0;

				if (z < -1.5 && prob < maxExtensionProbability) {
					return createBuySignal(cleanData, i, `Negative streak of ${N} bars with extension prob ${prob.toFixed(2)} < ${maxExtensionProbability}`);
				}
			} else if (currentStreak > 0) {
				// We are in a positive streak. Let N = currentStreak
				// We want P(streak of len N -> streak of len N+1), i.e., transitioning from N -> N+1
				const N = currentStreak;
				let countN = 0;
				let countNToNPlus1 = 0;

				for (let j = start; j <= end; j++) {
					if (streaks[j] === N) {
						countN++;
						if (streaks[j + 1] === N + 1) {
							countNToNPlus1++;
						}
					}
				}

				const prob = countN > 0 ? countNToNPlus1 / countN : 0;

				if (z > 1.5 && prob < maxExtensionProbability) {
					return createSellSignal(cleanData, i, `Positive streak of ${N} bars with extension prob ${prob.toFixed(2)} < ${maxExtensionProbability}`);
				}
			}

			return null;
		});
	},
	execute: (data, params) =>
		markov_streak_length_exhaustion.executePrepared!(
			markov_streak_length_exhaustion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "maxExtensionProbability"],
	},
};
