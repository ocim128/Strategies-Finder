import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeCloseLocationZscoreAlignmentParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 30)),
		threshold: Math.max(0.1, Number(params.threshold ?? 1.5)),
	};
}

export const close_location_zscore_alignment: Strategy = {
	name: "Close Location Z-Score Alignment",
	description: "Close location (where close sits within the bar's high-low range) is a microstructural proxy for intrabar taker aggression. The z-score of close location relative to its trailing distribution measures whether takers are consistently pressing one side.",
	defaultParams: {
		lookback: 30,
		threshold: 1.5,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Threshold",
	},
	normalizeParams: normalizeCloseLocationZscoreAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseLocationZscoreAlignmentParams(params);
		if (cleanData.length < p.lookback) return [];

		const closeLocation = buildCloseLocationSeries(cleanData);
		const zScore = buildRollingZScore(closeLocation, p.lookback);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < p.lookback) return null;
			const z = zScore[i];
			if (z === null) return null;

			if (z > p.threshold) {
				return createBuySignal(cleanData, i, `Close location z-score ${z.toFixed(3)} above threshold`);
			}
			if (z < -p.threshold) {
				return createSellSignal(cleanData, i, `Close location z-score ${z.toFixed(3)} below threshold`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
