import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore, buildPercentileRank } from "./price-action-statistics-core";
import { calculateVWAP } from "../indicators";

function normalizeVwapClimaxReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 20)),
		z_threshold: Math.max(0.1, Number(params.z_threshold ?? 1.5)),
		vol_min: Math.min(0.99, Math.max(0.01, Number(params.vol_min ?? 0.7))),
	};
}

export const vwap_climax_reversion: Strategy = {
	name: "VWAP Climax Reversion",
	description: "When price is at an unusual VWAP deviation AND volume spikes to an extreme percentile, a capitulation event is occurring. Volume percentile is the single gate that transforms a VWAP deviation from noise into a climax signal.",
	defaultParams: {
		lookback: 20,
		z_threshold: 1.5,
		vol_min: 0.7,
	},
	paramLabels: {
		lookback: "Lookback",
		z_threshold: "Z-Score Threshold",
		vol_min: "Min Volume Percentile",
	},
	normalizeParams: normalizeVwapClimaxReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVwapClimaxReversionParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const vwap = calculateVWAP(cleanData);
		const deviation: number[] = closes.map((c, i) => {
			const v = vwap[i];
			return v === null ? 0 : c - v;
		});
		const zScore = buildRollingZScore(deviation, p.lookback);
		const volRank = buildPercentileRank(volumes, p.lookback);

		return createSignalLoop(cleanData, [zScore, volRank], (i) => {
			if (i < p.lookback) return null;
			const z = zScore[i];
			const vr = volRank[i];
			if (z === null || vr === null) return null;

			if (vr < p.vol_min) return null;

			if (z < -p.z_threshold) {
				return createBuySignal(cleanData, i, `Selling climax at VWAP discount (z=${z.toFixed(2)}, vol pct=${vr.toFixed(2)})`);
			}
			if (z > p.z_threshold) {
				return createSellSignal(cleanData, i, `Buying climax at VWAP premium (z=${z.toFixed(2)}, vol pct=${vr.toFixed(2)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "z_threshold", "vol_min"],
	},
};
