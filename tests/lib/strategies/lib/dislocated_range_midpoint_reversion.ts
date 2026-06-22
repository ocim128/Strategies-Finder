import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRangeSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
		rangeThreshold: Math.max(0.01, Math.min(0.99, Number(params.rangeThreshold ?? 0.90))),
		midTolerance: Math.max(0.01, Math.min(0.49, Number(params.midTolerance ?? 0.15))),
	};
}

export const dislocated_range_midpoint_reversion: Strategy = {
	name: "Dislocated Range Midpoint Reversion",
	description: "Fades extreme intrabar leg disagreement (large range) when the close fails to hold the extremes and snaps back to the midpoint.",
	defaultParams: {
		lookback: 40,
		rangeThreshold: 0.90,
		midTolerance: 0.15,
	},
	paramLabels: {
		lookback: "Lookback Window",
		rangeThreshold: "Range Threshold",
		midTolerance: "Midpoint Tolerance",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const rangeThreshold = p.rangeThreshold as number;
		const midTolerance = p.midTolerance as number;
		if (cleanData.length < lookback) return [];

		const ranges = buildRangeSeries(cleanData);
		const rangePercentile = buildPercentileRank(ranges, lookback);
		const closeLocation = buildCloseLocationSeries(cleanData);
		const bodyDirections = extractBarMetricSeries(cleanData, "bodyDirection");

		return createSignalLoop(cleanData, [rangePercentile], (i) => {
			if (i < lookback) return null;
			const currentPercentile = rangePercentile[i];
			const closeLoc = closeLocation[i];
			const bodyDir = bodyDirections[i];
			if (currentPercentile === null || closeLoc === null || bodyDir === null) return null;

			if (currentPercentile <= rangeThreshold) return null;
			if (Math.abs(closeLoc - 0.5) > midTolerance) return null;

			if (bodyDir === -1) {
				return createBuySignal(cleanData, i, `Failed range breakout (percentile=${currentPercentile.toFixed(2)}), body direction bearish, close location ${closeLoc.toFixed(2)} near midpoint`);
			}
			if (bodyDir === 1) {
				return createSellSignal(cleanData, i, `Failed range breakout (percentile=${currentPercentile.toFixed(2)}), body direction bullish, close location ${closeLoc.toFixed(2)} near midpoint`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "rangeThreshold", "midTolerance"],
	},
};
