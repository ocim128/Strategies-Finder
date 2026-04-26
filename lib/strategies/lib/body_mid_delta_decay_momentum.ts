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

function normalizeBodyMidDeltaDecayMomentumParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		decay: Math.min(0.999, Math.max(0.01, Number(params.decay ?? 0.88))),
		z_lookback: Math.max(3, Math.round(params.z_lookback ?? 30)),
		z_threshold: Math.max(0.1, Number(params.z_threshold ?? 1.2)),
	};
}

export const body_mid_delta_decay_momentum: Strategy = {
	name: "Body-Mid Delta Decay Momentum",
	description: "Body midpoint delta measures where the body center sits relative to the bar midpoint. A cumulative decay sum of body-mid delta creates a smoothed initiative pressure reference. The sign of this decayed pressure directly gives the directional bias.",
	defaultParams: {
		decay: 0.88,
		z_lookback: 30,
		z_threshold: 1.2,
	},
	paramLabels: {
		decay: "Decay Factor",
		z_lookback: "Z-Score Lookback",
		z_threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeBodyMidDeltaDecayMomentumParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodyMidDeltaDecayMomentumParams(params);
		if (cleanData.length < p.z_lookback) return [];

		const bodyMidDelta = extractBarMetricSeries(cleanData, "bodyMidDelta");
		const decaySum = buildCumulativeDecaySum(bodyMidDelta, p.decay);
		const zScore = buildRollingZScore(decaySum, p.z_lookback);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < p.z_lookback) return null;
			const z = zScore[i];
			if (z === null) return null;

			if (z > p.z_threshold) {
				return createBuySignal(cleanData, i, `Body-mid delta z-score ${z.toFixed(3)} above threshold`);
			}
			if (z < -p.z_threshold) {
				return createSellSignal(cleanData, i, `Body-mid delta z-score ${z.toFixed(3)} below threshold`);
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
