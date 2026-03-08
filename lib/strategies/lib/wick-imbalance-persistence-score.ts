import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingAverage, clamp, getPriceActionBarMetrics } from "./price-action-frequency-core";

export const wick_imbalance_persistence_score: Strategy = {
	name: "Wick Imbalance Persistence Score",
	description: "Tracks persistent lower-vs-upper wick imbalance and confirms with the current candle body direction.",
	defaultParams: {
		lookback: 6,
		scoreThreshold: 0.3,
		minBodyPct: 0.2,
	},
	paramLabels: {
		lookback: "Score Window (bars)",
		scoreThreshold: "Persistence Threshold",
		minBodyPct: "Min Body/Range Ratio",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 3) return [];

		const lookback = Math.max(2, Math.round(params.lookback ?? 6));
		const scoreThreshold = clamp(params.scoreThreshold ?? 0.3, 0, 1);
		const minBodyPct = clamp(params.minBodyPct ?? 0.2, 0, 1);

		const barScore: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const metrics = getPriceActionBarMetrics(cleanData[i]);
			if (metrics.range <= 0 || metrics.bodyPct < minBodyPct) continue;
			barScore[i] = clamp((metrics.lowerWick - metrics.upperWick) / metrics.range, -1, 1);
		}

		const avgScore = buildRollingAverage(barScore, lookback);

		return createSignalLoop(cleanData, [avgScore], (i) => {
			const score = avgScore[i] as number;
			const bar = cleanData[i];

			if (score > scoreThreshold && bar.close > bar.open) {
				return createBuySignal(cleanData, i, "Wick imbalance persistence bullish");
			}
			if (score < -scoreThreshold && bar.close < bar.open) {
				return createSellSignal(cleanData, i, "Wick imbalance persistence bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "scoreThreshold", "minBodyPct"],
	},
};
