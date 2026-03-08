import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingAverage, clamp, getPriceActionBarMetrics } from "./price-action-frequency-core";

export const body_overlap_drift_score: Strategy = {
	name: "Body Overlap Drift Score",
	description: "Tracks gradual directional drift while consecutive candle bodies continue to overlap instead of fully expanding.",
	defaultParams: {
		lookback: 6,
		driftThreshold: 0.12,
		minOverlapPct: 0.45,
	},
	paramLabels: {
		lookback: "Score Window (bars)",
		driftThreshold: "Drift Threshold",
		minOverlapPct: "Min Body Overlap",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 4) return [];

		const lookback = Math.max(2, Math.round(params.lookback ?? 6));
		const driftThreshold = clamp(params.driftThreshold ?? 0.12, 0, 1);
		const minOverlapPct = clamp(params.minOverlapPct ?? 0.45, 0, 1);

		const barScore: number[] = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			const prevMetrics = getPriceActionBarMetrics(cleanData[i - 1]);
			const currMetrics = getPriceActionBarMetrics(cleanData[i]);
			const smallerBody = Math.min(prevMetrics.body, currMetrics.body);
			if (smallerBody <= 0) continue;

			const overlap = Math.max(
				0,
				Math.min(prevMetrics.bodyHigh, currMetrics.bodyHigh) -
					Math.max(prevMetrics.bodyLow, currMetrics.bodyLow)
			);
			const overlapPct = overlap / smallerBody;
			if (overlapPct < minOverlapPct) continue;

			const rangeRef = Math.max(prevMetrics.range, currMetrics.range, 1e-9);
			barScore[i] = clamp((currMetrics.bodyMid - prevMetrics.bodyMid) / rangeRef, -1, 1);
		}

		const avgScore = buildRollingAverage(barScore, lookback);

		return createSignalLoop(cleanData, [avgScore], (i) => {
			const score = avgScore[i] as number;
			const bar = cleanData[i];

			if (score > driftThreshold && bar.close > bar.open) {
				return createBuySignal(cleanData, i, "Body overlap drift bullish");
			}
			if (score < -driftThreshold && bar.close < bar.open) {
				return createSellSignal(cleanData, i, "Body overlap drift bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "driftThreshold", "minOverlapPct"],
	},
};
