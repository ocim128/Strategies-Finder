import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import {
	extractBarMetricSeries,
	buildCumulativeDecaySum,
	buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeCloseMidpointDeviationDecayParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		decay: Math.min(0.999, Math.max(0.01, Number(params.decay ?? 0.85))),
		z_lookback: Math.max(3, Math.round(params.z_lookback ?? 30)),
		z_threshold: Math.max(0.1, Number(params.z_threshold ?? 1.0)),
	};
}

export const close_midpoint_deviation_decay: Strategy = {
	name: "Close-Midpoint Deviation Decay",
	description: "The signed deviation of close from bar midpoint measures intrabar directional pressure. A cumulative decay sum of this deviation creates a smoothed, lag-aware pressure score. The sign of the decay sum directly gives the directional bias.",
	defaultParams: {
		decay: 0.85,
		z_lookback: 30,
		z_threshold: 1.0,
	},
	paramLabels: {
		decay: "Decay Factor",
		z_lookback: "Z-Score Lookback",
		z_threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeCloseMidpointDeviationDecayParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseMidpointDeviationDecayParams(params);
		if (cleanData.length < p.z_lookback) return [];

		const deviations = extractBarMetricSeries(cleanData, "closeMidpointDev");
		const decaySum = buildCumulativeDecaySum(deviations, p.decay);
		const zScore = buildRollingZScore(decaySum, p.z_lookback);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < p.z_lookback) return null;
			const z = zScore[i];
			if (z === null) return null;

			if (z > p.z_threshold) {
				return createBuySignal(cleanData, i, `Close-midpoint deviation z-score ${z.toFixed(3)} above threshold`);
			}
			if (z < -p.z_threshold) {
				return createSellSignal(cleanData, i, `Close-midpoint deviation z-score ${z.toFixed(3)} below threshold`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["decay", "z_lookback", "z_threshold"],
	},
};
