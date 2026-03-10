import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingStdDev, extractBarMetricSeries } from "./price-action-statistics-core";

export const stddev_compression_to_roc_surge: Strategy = {
	name: "StdDev Compression To ROC Surge",
	description: "Looks for return-variance collapse and only triggers when rate-of-change explodes out of that statistically flat state.",
	defaultParams: {
		lookbackPeriod: 14,
		varianceFloor: 0.2,
		surgeThreshold: 1.5,
	},
	paramLabels: {
		lookbackPeriod: "Lookback Period",
		varianceFloor: "Variance Floor (%)",
		surgeThreshold: "Surge Threshold (%)",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 5) return [];

		const lookbackPeriod = Math.max(2, Math.round(params.lookbackPeriod ?? 14));
		const varianceFloor = Math.max(0, params.varianceFloor ?? 0.2);
		const surgeThreshold = Math.max(0, params.surgeThreshold ?? 1.5);
		const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
		const closeReturnStdDevPct = buildRollingStdDev(closeReturn, lookbackPeriod).map((value) =>
			value === null ? null : value * 100
		);
		const rocPct = buildRateOfChange(getCloses(cleanData), lookbackPeriod).map((value) =>
			value === null ? null : value * 100
		);

		return createSignalLoop(cleanData, [closeReturnStdDevPct, rocPct], (i) => {
			const stdDev = closeReturnStdDevPct[i] as number;
			const roc = rocPct[i] as number;
			if (stdDev >= varianceFloor) return null;

			if (roc > surgeThreshold) {
				return createBuySignal(cleanData, i, "StdDev compression bullish ROC surge");
			}
			if (roc < -surgeThreshold) {
				return createSellSignal(cleanData, i, "StdDev compression bearish ROC surge");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookbackPeriod", "varianceFloor", "surgeThreshold"],
	},
};
