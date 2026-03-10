import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingStdDev, extractBarMetricSeries } from "./price-action-statistics-core";

export const fractal_volatility_pinch_impulse: Strategy = {
	name: "Fractal Volatility Pinch Impulse",
	description: "Compares fast and slow return variance and only fires when a compressed fractal ratio snaps with decisive ROC.",
	defaultParams: {
		fast_std_window: 10,
		slow_std_window: 50,
		pinch_ratio: 0.5,
		roc_trigger: 1.5,
	},
	paramLabels: {
		fast_std_window: "Fast StdDev Window",
		slow_std_window: "Slow StdDev Window",
		pinch_ratio: "Pinch Ratio",
		roc_trigger: "ROC Trigger (%)",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 5) return [];

		const fastStdWindow = Math.max(2, Math.round(params.fast_std_window ?? 10));
		const slowStdWindow = Math.max(fastStdWindow + 1, Math.round(params.slow_std_window ?? 50));
		const pinchRatio = Math.max(0, params.pinch_ratio ?? 0.5);
		const rocTrigger = Math.max(0, params.roc_trigger ?? 1.5);
		const closeReturnSeries = extractBarMetricSeries(cleanData, "closeReturn");
		const fastStd = buildRollingStdDev(closeReturnSeries, fastStdWindow);
		const slowStd = buildRollingStdDev(closeReturnSeries, slowStdWindow);
		const ratio: (number | null)[] = new Array(cleanData.length).fill(null);
		const rocPct = buildRateOfChange(getCloses(cleanData), fastStdWindow).map((value) =>
			value === null ? null : value * 100
		);

		for (let i = 0; i < cleanData.length; i++) {
			const fast = fastStd[i];
			const slow = slowStd[i];
			if (fast === null || slow === null || slow <= 0) continue;
			ratio[i] = fast / slow;
		}

		return createSignalLoop(cleanData, [ratio, rocPct], (i) => {
			let pinchActive = true;
			for (let j = Math.max(slowStdWindow - 1, i - fastStdWindow + 1); j <= i - 1; j++) {
				const ratioValue = ratio[j];
				if (ratioValue === null || ratioValue >= pinchRatio) {
					pinchActive = false;
					break;
				}
			}
			if (!pinchActive) return null;

			const rocValue = rocPct[i] as number;
			if (rocValue >= rocTrigger) {
				return createBuySignal(cleanData, i, "Fractal volatility pinch bullish impulse");
			}
			if (rocValue <= -rocTrigger) {
				return createSellSignal(cleanData, i, "Fractal volatility pinch bearish impulse");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fast_std_window", "slow_std_window", "pinch_ratio", "roc_trigger"],
	},
};
