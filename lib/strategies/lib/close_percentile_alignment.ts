import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeClosePercentileAlignmentParams(params: StrategyParams): StrategyParams {
	const lookback = Math.max(2, Math.round(Number(params.lookback ?? 126)));
	const threshold = Math.max(50, Math.min(99, Math.round(Number(params.threshold ?? 70))));
	return {
		...params,
		lookback,
		threshold };
}

export const close_percentile_alignment: Strategy = {
	name: "Close Percentile Alignment",
	description: "Measures the percentile rank of the current close inside the trailing distribution of past closes to detect when price occupies the upper or lower tail of its recent multi-month history.",
	defaultParams: {
		lookback: 126,
		threshold: 70 },
	paramLabels: {
		lookback: "Lookback",
		threshold: "Percentile Threshold" },
	normalizeParams: normalizeClosePercentileAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeClosePercentileAlignmentParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const rank = buildPercentileRank(closes, lookback);
		const upperThreshold = threshold / 100;
		const lowerThreshold = (100 - threshold) / 100;

		return createSignalLoop(cleanData, [rank], (i) => {
			const r = rank[i];
			if (r === null) return null;

			if (r > upperThreshold) {
				return createBuySignal(cleanData, i, `Percentile ${(r * 100).toFixed(1)}% above threshold ${threshold}%`);
			}
			if (r < lowerThreshold) {
				return createSellSignal(cleanData, i, `Percentile ${(r * 100).toFixed(1)}% below ${(100 - threshold)}%`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"] } };
