import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildThresholdCrossingCount } from "./price-action-statistics-core";

export const crossing_persistence_event_regime: Strategy = {
	name: "Crossing Persistence Event Regime",
	description: "Trades only when close stays on one side of its rolling average and crossover churn stays unusually low.",
	defaultParams: {
		lookback: 30,
		maxCrossings: 2,
		maPeriod: 20,
	},
	paramLabels: {
		lookback: "Regime Window",
		maxCrossings: "Max Crossings",
		maPeriod: "Rolling Average Period",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 5) return [];

		const lookback = Math.max(2, Math.round(params.lookback ?? 30));
		const maxCrossings = Math.max(0, Math.round(params.maxCrossings ?? 2));
		const maPeriod = Math.max(2, Math.round(params.maPeriod ?? 20));
		const closes = getCloses(cleanData);
		const rollingAverage = buildRollingAverage(closes, maPeriod);
		const closeVsAverage = closes.map((close, index) => {
			const avg = rollingAverage[index];
			return avg === null ? 0 : close - avg;
		});
		const crossingCount = buildThresholdCrossingCount(closeVsAverage, lookback, 0);

		return createSignalLoop(cleanData, [rollingAverage, crossingCount], (i) => {
			const avg = rollingAverage[i] as number;
			const crossings = crossingCount[i] as number;

			if (crossings < maxCrossings && closes[i] > avg) {
				return createBuySignal(cleanData, i, "Crossing persistence bullish regime");
			}
			if (crossings < maxCrossings && closes[i] < avg) {
				return createSellSignal(cleanData, i, "Crossing persistence bearish regime");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "maxCrossings", "maPeriod"],
	},
};
