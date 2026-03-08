import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildTrailingAverageRange, clamp, getPriceActionBarMetrics } from "./price-action-frequency-core";

export const failed_range_expansion_flip: Strategy = {
	name: "Failed Range Expansion Flip",
	description: "Fades oversized range expansion bars that probe one side and still close back through the previous midpoint.",
	defaultParams: {
		rangeLookback: 8,
		expansionFactor: 1.6,
		reclaimPct: 0.6,
	},
	paramLabels: {
		rangeLookback: "Range Lookback",
		expansionFactor: "Range Expansion Factor",
		reclaimPct: "Min Close-in-Range Reclaim",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 4) return [];

		const rangeLookback = Math.max(2, Math.round(params.rangeLookback ?? 8));
		const expansionFactor = Math.max(1, params.expansionFactor ?? 1.6);
		const reclaimPct = clamp(params.reclaimPct ?? 0.6, 0, 1);
		const avgRange = buildTrailingAverageRange(cleanData, rangeLookback, false);

		return createSignalLoop(cleanData, [avgRange], (i) => {
			const prev = cleanData[i - 1];
			const curr = cleanData[i];
			const metrics = getPriceActionBarMetrics(curr);
			const baselineRange = avgRange[i] as number;
			if (metrics.range <= 0 || baselineRange <= 0) return null;

			const prevMid = (prev.high + prev.low) / 2;
			const isExpanded = metrics.range >= baselineRange * expansionFactor;
			if (!isExpanded) return null;

			const bullishFlip =
				curr.low < prev.low &&
				curr.close > prevMid &&
				curr.close > curr.open &&
				metrics.closeLocation >= reclaimPct;
			if (bullishFlip) {
				return createBuySignal(cleanData, i, "Failed range expansion bullish flip");
			}

			const bearishFlip =
				curr.high > prev.high &&
				curr.close < prevMid &&
				curr.close < curr.open &&
				(1 - metrics.closeLocation) >= reclaimPct;
			if (bearishFlip) {
				return createSellSignal(cleanData, i, "Failed range expansion bearish flip");
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["rangeLookback", "expansionFactor", "reclaimPct"],
	},
};
