import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingEntropy, buildRollingMedian } from "./price-action-statistics-core";

function normalizeEntropyExhaustionFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropy_lookback: Math.max(3, Math.round(params.entropy_lookback ?? 20)),
		extreme_entropy: Math.max(0, Number(params.extreme_entropy ?? 0.2)),
	};
}

function hadRecentLowEntropy(entropy: (number | null)[], index: number, threshold: number): boolean {
	const start = Math.max(0, index - 2);
	for (let j = start; j <= index; j++) {
		const value = entropy[j];
		if (value !== null && value < threshold) return true;
	}
	return false;
}

export const entropy_exhaustion_fade: Strategy = {
	name: "Entropy Exhaustion Fade",
	description: "Fades the unwind after very low sequence entropy breaks back through a rolling median.",
	defaultParams: {
		entropy_lookback: 20,
		extreme_entropy: 0.2,
	},
	paramLabels: {
		entropy_lookback: "Entropy Lookback",
		extreme_entropy: "Extreme Entropy",
	},
	normalizeParams: normalizeEntropyExhaustionFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEntropyExhaustionFadeParams(params);
		const lookback = p.entropy_lookback as number;
		const extremeEntropy = p.extreme_entropy as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const closeDirection = closes.map((close, i) => {
			if (i === 0) return 0;
			if (close > closes[i - 1]) return 1;
			if (close < closes[i - 1]) return -1;
			return 0;
		});
		const entropy = buildRollingEntropy(closeDirection, lookback, 3);
		const median = buildRollingMedian(closes, lookback);

		return createSignalLoop(cleanData, [entropy, median], (i) => {
			if (i < lookback) return null;

			const currentMedian = median[i];
			const previousMedian = median[i - 1];
			if (currentMedian === null || previousMedian === null) return null;
			if (!hadRecentLowEntropy(entropy, i, extremeEntropy)) return null;

			if (closes[i - 1] <= previousMedian && closes[i] > currentMedian) {
				return createBuySignal(cleanData, i, "Low-entropy exhaustion reclaimed median");
			}
			if (closes[i - 1] >= previousMedian && closes[i] < currentMedian) {
				return createSellSignal(cleanData, i, "Low-entropy exhaustion lost median");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropy_lookback", "extreme_entropy"],
	},
};
