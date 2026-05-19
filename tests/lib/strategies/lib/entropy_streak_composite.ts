import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingEntropy, buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

const STRUCTURED_TREND_MEDIAN_LOOKBACK = 55;

function normalizeEntropyStreakCompositeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropy_lookback: Math.max(3, Math.round(params.entropy_lookback ?? 20)),
		entropy_threshold: Math.max(0, Number(params.entropy_threshold ?? 0.3)),
		streak_length: Math.max(1, Math.round(params.streak_length ?? 4)),
	};
}

export const entropy_streak_composite: Strategy = {
	name: "Entropy Streak Composite",
	description: "Enters trends from either low-entropy median alignment or visible close-streak auction persistence.",
	defaultParams: {
		entropy_lookback: 20,
		entropy_threshold: 0.3,
		streak_length: 4,
	},
	paramLabels: {
		entropy_lookback: "Entropy Lookback",
		entropy_threshold: "Entropy Threshold",
		streak_length: "Streak Length",
	},
	normalizeParams: normalizeEntropyStreakCompositeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEntropyStreakCompositeParams(params);
		const entropyLookback = p.entropy_lookback as number;
		const entropyThreshold = p.entropy_threshold as number;
		const streakLength = p.streak_length as number;
		if (cleanData.length < Math.max(entropyLookback, STRUCTURED_TREND_MEDIAN_LOOKBACK) + 2) return [];

		const closes = getCloses(cleanData);
		const closeFlags = closes.map((close, i) => {
			if (i === 0) return 0;
			if (close > closes[i - 1]) return 1;
			if (close < closes[i - 1]) return -1;
			return 0;
		});
		const entropy = buildRollingEntropy(closeFlags, entropyLookback, 3);
		const median = buildRollingMedian(closes, STRUCTURED_TREND_MEDIAN_LOOKBACK);
		const streak = buildStreakCount(closeFlags);

		return createSignalLoop(cleanData, [entropy, median], (i) => {
			if (i < Math.max(entropyLookback, STRUCTURED_TREND_MEDIAN_LOOKBACK)) return null;

			const currentEntropy = entropy[i];
			const currentMedian = median[i];
			if (currentEntropy === null || currentMedian === null) return null;

			const bullish = (currentEntropy < entropyThreshold && closes[i] > currentMedian)
				|| streak[i] >= streakLength;
			const bearish = (currentEntropy < entropyThreshold && closes[i] < currentMedian)
				|| streak[i] <= -streakLength;

			if (bullish && bearish) return null;
			if (bullish) {
				return createBuySignal(cleanData, i, "Entropy or streak composite bullish");
			}
			if (bearish) {
				return createSellSignal(cleanData, i, "Entropy or streak composite bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropy_lookback", "entropy_threshold", "streak_length"],
	},
};
