import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { buildCumulativeDecaySum, buildRollingZScore, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeKineticDecayPhiLimitParams(params: StrategyParams): StrategyParams {
	const decayRate = Math.max(0.01, Math.min(0.99, Number(params.decayRate ?? 0.618)));
	const zscoreLookback = Math.max(10, Math.round(params.zscoreLookback ?? 89));
	const phiZScoreExtreme = Math.max(0.5, Number(params.phiZScoreExtreme ?? 1.618));
	return { ...params, decayRate, zscoreLookback, phiZScoreExtreme };
}

export const kinetic_decay_phi_limit: Strategy = {
	name: "Kinetic Decay Phi Limit",
	description:
		"Detects trend exhaustion when the decayed kinetic sum of price direction hits a 1.618 Z-score, using 0.618 retention for a perfectly scaled harmonic oscillator.",
	defaultParams: { decayRate: 0.618, zscoreLookback: 89, phiZScoreExtreme: 1.618 },
	paramLabels: { decayRate: "Decay Rate", zscoreLookback: "Z-Score Lookback", phiZScoreExtreme: "Phi Z-Score Extreme" },
	normalizeParams: normalizeKineticDecayPhiLimitParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeKineticDecayPhiLimitParams(params);
		const minBars = np.zscoreLookback + 2;
		if (cleanData.length < minBars) return [];

		const closeReturns = extractBarMetricSeries(cleanData, "closeReturn");
		const decayed = buildCumulativeDecaySum(closeReturns, np.decayRate);
		const zscore = buildRollingZScore(decayed, np.zscoreLookback);
		const closeLocation = extractBarMetricSeries(cleanData, "closeLocation");

		const signals = [];
		for (let i = minBars; i < cleanData.length; i++) {
			const z = zscore[i];
			const zPrev = zscore[i - 1];
			if (z === null || zPrev === null) continue;

			if (zPrev > -np.phiZScoreExtreme && z <= -np.phiZScoreExtreme && closeLocation[i] > 0.618) {
				signals.push(createBuySignal(cleanData, i, `Kinetic decay Z crossed below -${np.phiZScoreExtreme} & CL > 0.618`));
			}
			if (zPrev < np.phiZScoreExtreme && z >= np.phiZScoreExtreme && closeLocation[i] < 0.382) {
				signals.push(createSellSignal(cleanData, i, `Kinetic decay Z crossed above ${np.phiZScoreExtreme} & CL < 0.382`));
			}
		}
		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["decayRate", "zscoreLookback", "phiZScoreExtreme"],
	},
};
