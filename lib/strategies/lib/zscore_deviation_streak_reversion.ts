import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingZScore, buildStreakCount } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
		zScoreBoundary: Math.max(0.1, Number(params.zScoreBoundary ?? 1.8)),
		streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 4))),
	};
}

export const zscore_deviation_streak_reversion: Strategy = {
	name: "Z-Score Deviation Streak Reversion",
	description: "Fades consecutive extreme rolling z-score close deviations on the first positive/negative return bar.",
	defaultParams: {
		lookback: 20,
		zScoreBoundary: 1.8,
		streakThreshold: 4,
	},
	paramLabels: {
		lookback: "Lookback Window",
		zScoreBoundary: "Z-Score Boundary",
		streakThreshold: "Streak Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		closes: getCloses(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const zScoreBoundary = p.zScoreBoundary as number;
		const streakThreshold = p.streakThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < Math.max(lookback, streakThreshold + 2)) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		// Compute streaks
		const upperFlags = new Array(cleanData.length).fill(0);
		const lowerFlags = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			const z = zscore[j];
			if (z !== null) {
				if (z > zScoreBoundary) {
					upperFlags[j] = 1;
				} else if (z < -zScoreBoundary) {
					lowerFlags[j] = -1;
				}
			}
		}
		const upperStreaks = buildStreakCount(upperFlags);
		const lowerStreaks = buildStreakCount(lowerFlags);

		return createSignalLoop(cleanData, [zscore], (i) => {
			if (i < Math.max(lookback, streakThreshold + 1)) return null;

			// Buy: Z-score has been below -zScoreBoundary for streakThreshold consecutive bars,
			// followed by the first close that prints a positive return.
			if (lowerStreaks[i - 1] <= -streakThreshold && closes[i] > closes[i - 1]) {
				return createBuySignal(cleanData, i, `Z-Score streak reversion buy: streak of ${Math.abs(lowerStreaks[i - 1])} bars, return positive`);
			}
			// Sell: Z-score has been above zScoreBoundary for streakThreshold consecutive bars,
			// followed by the first close that prints a negative return.
			if (upperStreaks[i - 1] >= streakThreshold && closes[i] < closes[i - 1]) {
				return createSellSignal(cleanData, i, `Z-Score streak reversion sell: streak of ${upperStreaks[i - 1]} bars, return negative`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		zscore_deviation_streak_reversion.executePrepared!(
			zscore_deviation_streak_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "zScoreBoundary", "streakThreshold"],
	},
};
