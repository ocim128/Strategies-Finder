import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildCumulativeDecaySum } from "./price-action-statistics-core";

function normalizeThetaWeightedMomentumZeroCrossParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		decayFactor: Math.max(0.01, Math.min(0.999, Number(params.decayFactor ?? 0.6))) };
}

export const theta_weighted_momentum_zero_cross: Strategy = {
	name: "Theta Weighted Momentum Zero Cross",
	description: "A fast-decay cumulative sum of bar direction produces theta-weighted momentum where only recent bars matter. When this crosses zero, short-term dealer positioning has shifted before it shows up in slower indicators. Enter in the new direction.",
	defaultParams: {
		decayFactor: 0.6 },
	paramLabels: {
		decayFactor: "Decay Factor" },
	normalizeParams: normalizeThetaWeightedMomentumZeroCrossParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeThetaWeightedMomentumZeroCrossParams(params);
		const decayFactor = p.decayFactor as number;
		if (cleanData.length < 3) return [];

		const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
		const decayedMomentum = buildCumulativeDecaySum(bodyDir, decayFactor);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1) return null;

			if (decayedMomentum[i - 1] < 0 && decayedMomentum[i] >= 0) {
				return createBuySignal(cleanData, i, `Theta-weighted momentum crossed zero bullish (${decayedMomentum[i - 1].toFixed(3)}→${decayedMomentum[i].toFixed(3)})`);
			}
			if (decayedMomentum[i - 1] > 0 && decayedMomentum[i] <= 0) {
				return createSellSignal(cleanData, i, `Theta-weighted momentum crossed zero bearish (${decayedMomentum[i - 1].toFixed(3)}→${decayedMomentum[i].toFixed(3)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["decayFactor"] } };
