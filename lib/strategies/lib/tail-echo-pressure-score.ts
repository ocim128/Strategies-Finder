import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingAverage, clamp, getPriceActionBarMetrics } from "./price-action-frequency-core";

export const tail_echo_pressure_score: Strategy = {
	name: "Tail Echo Pressure Score",
	description: "Measures repeated same-side tail dominance that keeps closing with directional pressure.",
	defaultParams: {
		lookback: 6,
		scoreThreshold: 0.22,
		dominanceThreshold: 0.2,
	},
	paramLabels: {
		lookback: "Score Window (bars)",
		scoreThreshold: "Persistence Threshold",
		dominanceThreshold: "Min Tail Dominance",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 3) return [];

		const lookback = Math.max(2, Math.round(params.lookback ?? 6));
		const scoreThreshold = clamp(params.scoreThreshold ?? 0.22, 0, 1);
		const dominanceThreshold = clamp(params.dominanceThreshold ?? 0.2, 0, 1);

		const barScore: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const metrics = getPriceActionBarMetrics(cleanData[i]);
			if (metrics.range <= 0) continue;

			const dominance = clamp((metrics.lowerWick - metrics.upperWick) / metrics.range, -1, 1);
			if (dominance > dominanceThreshold && metrics.closeLocation > 0.55) {
				barScore[i] = dominance;
			} else if (dominance < -dominanceThreshold && metrics.closeLocation < 0.45) {
				barScore[i] = dominance;
			}
		}

		const avgScore = buildRollingAverage(barScore, lookback);

		return createSignalLoop(cleanData, [avgScore], (i) => {
			const score = avgScore[i] as number;
			if (score > scoreThreshold) {
				return createBuySignal(cleanData, i, "Tail echo pressure bullish");
			}
			if (score < -scoreThreshold) {
				return createSellSignal(cleanData, i, "Tail echo pressure bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "scoreThreshold", "dominanceThreshold"],
	},
};
