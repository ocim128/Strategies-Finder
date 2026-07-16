import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingZScore, buildStreakCount } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	tr: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
		streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 3))),
		reversionZScore: Math.max(0.1, Number(params.reversionZScore ?? 1.5)),
	};
}

export const true_range_expansion_streak_exhaustion: Strategy = {
	name: "True Range Expansion Streak Exhaustion",
	description: "Fades true range expansion exhaustion at z-score price extremes when expansion halts.",
	defaultParams: {
		lookback: 20,
		streakThreshold: 3,
		reversionZScore: 1.5,
	},
	paramLabels: {
		lookback: "Lookback Window",
		streakThreshold: "Streak Threshold",
		reversionZScore: "Reversion Z-Score",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		closes: getCloses(data),
		tr: extractBarMetricSeries(data, "trueRange"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const streakThreshold = p.streakThreshold as number;
		const reversionZScore = p.reversionZScore as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < Math.max(lookback, streakThreshold + 2)) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const tr = prepared?.tr ?? extractBarMetricSeries(cleanData, "trueRange");
		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		// Compute expansion streaks
		const expansionFlags = new Array(cleanData.length).fill(0);
		for (let j = 1; j < cleanData.length; j++) {
			if (tr[j] > tr[j - 1]) {
				expansionFlags[j] = 1;
			}
		}
		const expansionStreaks = buildStreakCount(expansionFlags);

		return createSignalLoop(cleanData, [zscore], (i) => {
			if (i < Math.max(lookback, streakThreshold + 1)) return null;

			const z = zscore[i];
			if (z === null) return null;

			// Buy: A streak of expanding true ranges has run for streakThreshold bars at i-1
			// while the price is down (Z-score below -reversionZScore), and current bar posts smaller true range
			if (expansionStreaks[i - 1] >= streakThreshold && z < -reversionZScore && tr[i] < tr[i - 1]) {
				return createBuySignal(cleanData, i, `TR expansion streak of ${expansionStreaks[i - 1]} bars exhausted (buy)`);
			}
			// Sell: A streak of expanding true ranges has run for streakThreshold bars at i-1
			// while the price is up (Z-score above reversionZScore), and current bar posts smaller true range
			if (expansionStreaks[i - 1] >= streakThreshold && z > reversionZScore && tr[i] < tr[i - 1]) {
				return createSellSignal(cleanData, i, `TR expansion streak of ${expansionStreaks[i - 1]} bars exhausted (sell)`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		true_range_expansion_streak_exhaustion.executePrepared!(
			true_range_expansion_streak_exhaustion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "streakThreshold", "reversionZScore"],
	},
};
