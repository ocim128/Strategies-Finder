import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		imbalanceThreshold: Math.max(0, Math.min(1, Number(params.imbalanceThreshold ?? 0.7))),
		streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 3))),
	};
}

export const wick_imbalance_streak_fade: Strategy = {
	name: "Wick Imbalance Streak Fade",
	description: "Fades consecutive bars with high wick asymmetry pointing in one direction.",
	defaultParams: {
		imbalanceThreshold: 0.7,
		streakThreshold: 3,
	},
	paramLabels: {
		imbalanceThreshold: "Imbalance Threshold",
		streakThreshold: "Streak Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const imbalanceThreshold = p.imbalanceThreshold as number;
		const streakThreshold = p.streakThreshold as number;

		if (cleanData.length < streakThreshold + 1) return [];

		// extractBarMetricSeries returns (lowerWick - upperWick) / range
		const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");

		// Compute streaks
		const upperFlags = new Array(cleanData.length).fill(0);
		const lowerFlags = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			const imb = wickImbalance[j];
			if (imb > imbalanceThreshold) {
				lowerFlags[j] = 1; // Lower wick disproportionately large -> downside rejection
			} else if (imb < -imbalanceThreshold) {
				upperFlags[j] = -1; // Upper wick disproportionately large -> upside rejection
			}
		}
		const lowerStreaks = buildStreakCount(lowerFlags);
		const upperStreaks = buildStreakCount(upperFlags);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < streakThreshold) return null;

			// Buy: lower wick imbalance (downside rejection) exceeds threshold for streakThreshold bars
			if (lowerStreaks[i] >= streakThreshold) {
				return createBuySignal(cleanData, i, `Downside wick rejection streak of ${lowerStreaks[i]} bars (buy fade)`);
			}
			// Sell: upper wick imbalance (upside rejection) exceeds threshold for streakThreshold bars
			if (upperStreaks[i] <= -streakThreshold) {
				return createSellSignal(cleanData, i, `Upside wick rejection streak of ${Math.abs(upperStreaks[i])} bars (sell fade)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["imbalanceThreshold", "streakThreshold"],
	},
};
