import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";
import { calculateVWAP } from "../indicators";

function normalizeVwapSlopeZscoreParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		roc_period: Math.max(1, Math.round(params.roc_period ?? 5)),
		z_lookback: Math.max(3, Math.round(params.z_lookback ?? 30)),
		z_threshold: Math.max(0.1, Number(params.z_threshold ?? 1.0)),
	};
}

export const vwap_slope_zscore: Strategy = {
	name: "VWAP Slope Z-Score",
	description: "The rate of change of VWAP measures how fast the volume-weighted consensus value itself is being repriced. Z-scoring this slope identifies when value is shifting unusually fast relative to recent history.",
	defaultParams: {
		roc_period: 5,
		z_lookback: 30,
		z_threshold: 1.0,
	},
	paramLabels: {
		roc_period: "ROC Period",
		z_lookback: "Z-Score Lookback",
		z_threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeVwapSlopeZscoreParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVwapSlopeZscoreParams(params);
		if (cleanData.length < p.z_lookback + p.roc_period) return [];

		const vwap = calculateVWAP(cleanData);
		const vwapValues: number[] = vwap.map((v) => (v === null ? 0 : v));
		const vwapRoc = buildRateOfChange(vwapValues, p.roc_period);
		const rocClean: number[] = vwapRoc.map((v) => (v === null ? 0 : v));
		const zScore = buildRollingZScore(rocClean, p.z_lookback);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < p.z_lookback + p.roc_period) return null;
			const z = zScore[i];
			if (z === null) return null;

			if (z > p.z_threshold) {
				return createBuySignal(cleanData, i, `VWAP slope z-score ${z.toFixed(3)} — value repricing upward`);
			}
			if (z < -p.z_threshold) {
				return createSellSignal(cleanData, i, `VWAP slope z-score ${z.toFixed(3)} — value repricing downward`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["roc_period", "z_lookback", "z_threshold"],
	},
};
