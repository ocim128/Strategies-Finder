import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 20))),
		rocZThreshold: Math.max(0.1, Number(params.rocZThreshold ?? 2.0)),
	};
}

export const rate_of_change_zscore_breakout: Strategy = {
	name: "Rate of Change Z-Score Breakout",
	description: "Follows momentum when the rolling z-score of the rate of change breaks out above a threshold, confirmed by a healthy volume percentile rank.",
	defaultParams: {
		lookback: 20,
		rocZThreshold: 2.0,
	},
	paramLabels: {
		lookback: "Lookback Window",
		rocZThreshold: "ROC Z-Score Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const rocZThreshold = p.rocZThreshold as number;
		if (cleanData.length < lookback * 2) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const volPercentile = buildPercentileRank(volumes, lookback);

		const roc = buildRateOfChange(closes, 1).map(v => v !== null ? v : 0);
		const rocZ = buildRollingZScore(roc, lookback);

		return createSignalLoop(cleanData, [rocZ, volPercentile], (i) => {
			if (i < lookback * 2) return null;
			const rz = rocZ[i];
			const vp = volPercentile[i];
			if (rz === null || vp === null) return null;

			if (vp <= 0.50) return null;

			if (rz > rocZThreshold) {
				return createBuySignal(cleanData, i, `ROC z-score (${rz.toFixed(2)}) > ${rocZThreshold} with volume percentile (${vp.toFixed(2)}) > 0.50`);
			}
			if (rz < -rocZThreshold) {
				return createSellSignal(cleanData, i, `ROC z-score (${rz.toFixed(2)}) < -${rocZThreshold} with volume percentile (${vp.toFixed(2)}) > 0.50`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "rocZThreshold"],
	},
};
