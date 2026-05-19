import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingMedian, buildRollingZScore } from "./price-action-statistics-core";

function normalizeVolumeGatedMedianCrossParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		median_lookback: Math.max(3, Math.round(params.median_lookback ?? 55)),
		vol_z_threshold: Math.max(0, Number(params.vol_z_threshold ?? 1.5)),
	};
}

export const volume_gated_median_cross: Strategy = {
	name: "Volume Gated Median Cross",
	description: "Takes median crosses only when the breakout bar has a significant positive volume z-score.",
	defaultParams: {
		median_lookback: 55,
		vol_z_threshold: 1.5,
	},
	paramLabels: {
		median_lookback: "Median Lookback",
		vol_z_threshold: "Volume Z Threshold",
	},
	normalizeParams: normalizeVolumeGatedMedianCrossParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeGatedMedianCrossParams(params);
		const lookback = p.median_lookback as number;
		const volumeThreshold = p.vol_z_threshold as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const median = buildRollingMedian(closes, lookback);
		const volumeZScore = buildRollingZScore(volumes, lookback);

		return createSignalLoop(cleanData, [median, volumeZScore], (i) => {
			if (i < lookback) return null;

			const currentMedian = median[i];
			const previousMedian = median[i - 1];
			const volumeZ = volumeZScore[i];
			if (currentMedian === null || previousMedian === null || volumeZ === null || volumeZ <= volumeThreshold) return null;

			if (closes[i - 1] <= previousMedian && closes[i] > currentMedian) {
				return createBuySignal(cleanData, i, "Volume-gated median cross up");
			}
			if (closes[i - 1] >= previousMedian && closes[i] < currentMedian) {
				return createSellSignal(cleanData, i, "Volume-gated median cross down");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["median_lookback", "vol_z_threshold"],
	},
};
