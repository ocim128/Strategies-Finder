import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import {
	buildTrailingAverageRange,
	buildTrailingHighLow,
	buildTrailingWindowSpan,
	clamp,
	getPriceActionBarMetrics,
} from "./price-action-frequency-core";

export const compression_reclaim_impulse: Strategy = {
	name: "Compression Reclaim Impulse",
	description: "Triggers when a tight overlapping regime breaks the wrong way and immediately reclaims on the close.",
	defaultParams: {
		compressionLookback: 6,
		compressionThreshold: 0.42,
		reclaimPct: 0.62,
	},
	paramLabels: {
		compressionLookback: "Compression Lookback",
		compressionThreshold: "Compression Ratio Max",
		reclaimPct: "Min Close-in-Range Reclaim",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 4) return [];

		const compressionLookback = Math.max(2, Math.round(params.compressionLookback ?? 6));
		const compressionThreshold = clamp(params.compressionThreshold ?? 0.42, 0, 1);
		const reclaimPct = clamp(params.reclaimPct ?? 0.62, 0, 1);
		const avgRange = buildTrailingAverageRange(cleanData, compressionLookback, false);
		const span = buildTrailingWindowSpan(cleanData, compressionLookback, false);
		const { highest, lowest } = buildTrailingHighLow(cleanData, compressionLookback, false);

		return createSignalLoop(cleanData, [avgRange, span, highest, lowest], (i) => {
			const prev = cleanData[i - 1];
			const curr = cleanData[i];
			const metrics = getPriceActionBarMetrics(curr);
			const baselineRange = avgRange[i] as number;
			const windowSpan = span[i] as number;
			const windowHigh = highest[i] as number;
			const windowLow = lowest[i] as number;
			if (metrics.range <= 0 || baselineRange <= 0 || windowSpan <= 0) return null;

			const compressionRatio = baselineRange / windowSpan;
			if (compressionRatio > compressionThreshold) return null;

			const bullishImpulse =
				curr.low < windowLow &&
				curr.close > prev.close &&
				curr.close > curr.open &&
				metrics.closeLocation >= reclaimPct;
			if (bullishImpulse) {
				return createBuySignal(cleanData, i, "Compression reclaim bullish");
			}

			const bearishImpulse =
				curr.high > windowHigh &&
				curr.close < prev.close &&
				curr.close < curr.open &&
				(1 - metrics.closeLocation) >= reclaimPct;
			if (bearishImpulse) {
				return createSellSignal(cleanData, i, "Compression reclaim bearish");
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["compressionLookback", "compressionThreshold", "reclaimPct"],
	},
};
