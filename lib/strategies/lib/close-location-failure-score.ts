import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingAverage, clamp, getPriceActionBarMetrics } from "./price-action-frequency-core";

export const close_location_failure_score: Strategy = {
	name: "Close Location Failure Score",
	description: "Looks for candles that probe one side first and still finish with strong close placement in the opposite direction.",
	defaultParams: {
		lookback: 5,
		closeLocationThreshold: 0.72,
		probePct: 0.18,
	},
	paramLabels: {
		lookback: "Score Window (bars)",
		closeLocationThreshold: "Close Location Threshold",
		probePct: "Min Opposite Probe",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 3) return [];

		const lookback = Math.max(2, Math.round(params.lookback ?? 5));
		const closeLocationThreshold = clamp(params.closeLocationThreshold ?? 0.72, 0.5, 1);
		const probePct = clamp(params.probePct ?? 0.18, 0, 1);
		const persistenceThreshold = Math.max(0.15, (closeLocationThreshold - 0.5) * 0.75);

		const barScore: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const bar = cleanData[i];
			const metrics = getPriceActionBarMetrics(bar);
			if (metrics.range <= 0) continue;

			const lowerProbe = clamp((Math.min(bar.open, bar.close) - bar.low) / metrics.range, 0, 1);
			const upperProbe = clamp((bar.high - Math.max(bar.open, bar.close)) / metrics.range, 0, 1);

			if (lowerProbe >= probePct && metrics.closeLocation >= closeLocationThreshold) {
				barScore[i] = clamp((metrics.closeLocation - 0.5) * 2, 0, 1);
			} else if (upperProbe >= probePct && metrics.closeLocation <= 1 - closeLocationThreshold) {
				barScore[i] = -clamp((0.5 - metrics.closeLocation) * 2, 0, 1);
			}
		}

		const avgScore = buildRollingAverage(barScore, lookback);

		return createSignalLoop(cleanData, [avgScore], (i) => {
			const score = avgScore[i] as number;
			if (score > persistenceThreshold) {
				return createBuySignal(cleanData, i, "Close location failure bullish");
			}
			if (score < -persistenceThreshold) {
				return createSellSignal(cleanData, i, "Close location failure bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "closeLocationThreshold", "probePct"],
	},
};
