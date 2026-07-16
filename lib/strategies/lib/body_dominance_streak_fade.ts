import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getOpens,
} from "../strategy-helpers";
import { extractBarMetricSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		bodyRatioThreshold: Math.max(0, Math.min(1, Number(params.bodyRatioThreshold ?? 0.75))),
		streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 3))),
	};
}

export const body_dominance_streak_fade: Strategy = {
	name: "Body Dominance Streak Fade",
	description: "Fades consecutive large candle bodies in one direction when the current close location reverts.",
	defaultParams: {
		bodyRatioThreshold: 0.75,
		streakThreshold: 3,
	},
	paramLabels: {
		bodyRatioThreshold: "Body Ratio Threshold",
		streakThreshold: "Streak Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const bodyRatioThreshold = p.bodyRatioThreshold as number;
		const streakThreshold = p.streakThreshold as number;

		if (cleanData.length < streakThreshold + 2) return [];

		const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
		const closeLocation = buildCloseLocationSeries(cleanData);
		const closes = getCloses(cleanData);
		const opens = getOpens(cleanData);

		// Compute body dominance streaks
		const bearishDominance = new Array(cleanData.length).fill(0);
		const bullishDominance = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			if (bodyPct[j] >= bodyRatioThreshold) {
				if (closes[j] < opens[j]) {
					bearishDominance[j] = -1;
				} else if (closes[j] > opens[j]) {
					bullishDominance[j] = 1;
				}
			}
		}
		const bearishStreaks = buildStreakCount(bearishDominance);
		const bullishStreaks = buildStreakCount(bullishDominance);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < streakThreshold + 1) return null;

			// Buy: bearish bodies streak completed by i-1, and current closeLocation is above 0.5
			if (bearishStreaks[i - 1] <= -streakThreshold && closeLocation[i] > 0.5) {
				return createBuySignal(cleanData, i, `Bearish body dominance streak of ${Math.abs(bearishStreaks[i - 1])} bars faded`);
			}
			// Sell: bullish bodies streak completed by i-1, and current closeLocation is below 0.5
			if (bullishStreaks[i - 1] >= streakThreshold && closeLocation[i] < 0.5) {
				return createSellSignal(cleanData, i, `Bullish body dominance streak of ${bullishStreaks[i - 1]} bars faded`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["bodyRatioThreshold", "streakThreshold"],
	},
};
