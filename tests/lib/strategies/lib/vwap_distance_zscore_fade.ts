import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { calculateVWAP } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		z_lookback: Math.max(2, Math.round(params.z_lookback ?? 50)),
		z_thresh: Number(params.z_thresh ?? 3.0),
	};
}

export const vwap_distance_zscore_fade: Strategy = {
	name: "VWAP Distance Z-Score Fade",
	description: "Continuous VWAP acts as the true market mean. When the absolute distance from price to VWAP reaches a statistical extreme, it snaps back.",
	defaultParams: {
		z_lookback: 50,
		z_thresh: 3.0,
	},
	paramLabels: {
		z_lookback: "Z-Score Lookback",
		z_thresh: "Z-Score Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeParams(params);
		if (cleanData.length < normalizedParams.z_lookback) return [];

		const vwap = calculateVWAP(cleanData);
		const closes = getCloses(cleanData);
		const distances = new Array(cleanData.length).fill(0);

		for (let i = 0; i < cleanData.length; i++) {
			if (vwap[i] === null) continue;
			distances[i] = closes[i]! - vwap[i]!;
		}

		const zscores = buildRollingZScore(distances, normalizedParams.z_lookback);

		return createSignalLoop(cleanData, [vwap, zscores], (i) => {
			const z = zscores[i]!;
			
			if (z <= -normalizedParams.z_thresh) {
				return createBuySignal(cleanData, i, "Z-Score of (Close - VWAP) falls below -thresh");
			}
			
			if (z >= normalizedParams.z_thresh) {
				return createSellSignal(cleanData, i, "Z-Score of (Close - VWAP) rises above +thresh");
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["z_lookback", "z_thresh"],
	},
};
