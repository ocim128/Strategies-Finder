import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum, buildRollingZScore } from "./price-action-statistics-core";

function normalizeAcceptanceDecayConvictionReversalParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		decayFactor: Math.max(0.01, Math.min(0.999, Number(params.decayFactor ?? 0.85))),
		zThreshold: Math.max(0.5, Math.abs(Number(params.zThreshold ?? 2.5))) };
}

export const acceptance_decay_conviction_reversal: Strategy = {
	name: "Acceptance Decay Conviction Reversal",
	description: "Exponentially decaying cumulative sum of close acceptance creates a conviction memory where recent settlements carry more weight. When decayed conviction reaches an extreme z-score and raw acceptance reverses sign, the accumulated conviction has peaked. Enter in the reversal direction.",
	defaultParams: {
		decayFactor: 0.85,
		zThreshold: 2.5 },
	paramLabels: {
		decayFactor: "Decay Factor",
		zThreshold: "Z-Score Threshold" },
	normalizeParams: normalizeAcceptanceDecayConvictionReversalParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeAcceptanceDecayConvictionReversalParams(params);
		const decayFactor = p.decayFactor as number;
		const zThreshold = p.zThreshold as number;
		if (cleanData.length < 52) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const decayedConviction = buildCumulativeDecaySum(acceptance, decayFactor);
		const zScore = buildRollingZScore(decayedConviction, 50);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < 51) return null;
			const priorZ = zScore[i - 1];
			const currZ = zScore[i];
			if (priorZ === null || currZ === null) return null;

			if (priorZ < -zThreshold && acceptance[i] > 0) {
				return createBuySignal(cleanData, i, `Decayed conviction z-score extreme bearish (${priorZ.toFixed(2)}), acceptance flipped positive`);
			}
			if (priorZ > zThreshold && acceptance[i] < 0) {
				return createSellSignal(cleanData, i, `Decayed conviction z-score extreme bullish (${priorZ.toFixed(2)}), acceptance flipped negative`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["decayFactor", "zThreshold"] } };
