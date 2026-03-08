import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingAverage, clamp } from "./price-action-frequency-core";

export const follow_through_failure_persistence: Strategy = {
	name: "Follow-Through Failure Persistence",
	description: "Scores repeated failed continuation bars that extend beyond the prior extreme but cannot hold directional closes.",
	defaultParams: {
		lookback: 6,
		failureThreshold: 0.4,
		minExcursionPct: 0.12,
	},
	paramLabels: {
		lookback: "Score Window (bars)",
		failureThreshold: "Persistence Threshold",
		minExcursionPct: "Min Extreme Excursion",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 4) return [];

		const lookback = Math.max(2, Math.round(params.lookback ?? 6));
		const failureThreshold = clamp(params.failureThreshold ?? 0.4, 0, 1);
		const minExcursionPct = clamp(params.minExcursionPct ?? 0.12, 0, 1);

		const barScore: number[] = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			const prev = cleanData[i - 1];
			const curr = cleanData[i];
			const prevRange = prev.high - prev.low;
			if (prevRange <= 0) continue;

			const downsideExcursion = (prev.low - curr.low) / prevRange;
			if (curr.low < prev.low && downsideExcursion >= minExcursionPct && curr.close >= prev.close) {
				barScore[i] = 1;
				continue;
			}

			const upsideExcursion = (curr.high - prev.high) / prevRange;
			if (curr.high > prev.high && upsideExcursion >= minExcursionPct && curr.close <= prev.close) {
				barScore[i] = -1;
			}
		}

		const avgScore = buildRollingAverage(barScore, lookback);

		return createSignalLoop(cleanData, [avgScore], (i) => {
			const score = avgScore[i] as number;
			if (score > failureThreshold) {
				return createBuySignal(cleanData, i, "Follow-through failure bullish");
			}
			if (score < -failureThreshold) {
				return createSellSignal(cleanData, i, "Follow-through failure bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "failureThreshold", "minExcursionPct"],
	},
};
