import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingMinMax, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		volThreshold: Math.max(0.01, Math.min(0.99, Number(params.volThreshold ?? 0.70))),
	};
}

export const rolling_min_max_breakout: Strategy = {
	name: "Rolling Min-Max Breakout",
	description: "Follows breakouts of the rolling high or low over a lookback window, confirmed by high relative proxy volume on the illiquid leg.",
	defaultParams: {
		lookback: 30,
		volThreshold: 0.70,
	},
	paramLabels: {
		lookback: "Lookback Window",
		volThreshold: "Volume Percentile Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const volThreshold = p.volThreshold as number;
		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const volPercentile = buildPercentileRank(volumes, lookback);
		const minMax = buildRollingMinMax(closes, lookback, true);

		return createSignalLoop(cleanData, [volPercentile], (i) => {
			if (i < lookback) return null;
			const vp = volPercentile[i];
			if (vp === null || vp <= volThreshold) return null;

			const close = closes[i];
			const maxVal = minMax.max[i];
			const minVal = minMax.min[i];
			if (maxVal === null || minVal === null) return null;

			if (close >= maxVal) {
				return createBuySignal(cleanData, i, `Close breakout above rolling max ${maxVal.toFixed(4)} with volume percentile (${vp.toFixed(2)}) > ${volThreshold}`);
			}
			if (close <= minVal) {
				return createSellSignal(cleanData, i, `Close breakdown below rolling min ${minVal.toFixed(4)} with volume percentile (${vp.toFixed(2)}) > ${volThreshold}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "volThreshold"],
	},
};
