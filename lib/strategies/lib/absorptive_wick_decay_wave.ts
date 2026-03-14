import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { buildCumulativeDecaySum, extractBarMetricSeries } from "./price-action-statistics-core";
import { clamp, getPriceActionBarMetrics } from "./price-action-frequency-core";

function normalizeAbsorptiveWickDecayWaveParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		decay_factor: clamp(params.decay_factor ?? 0.85, 0.01, 0.999),
		absorption_threshold: Math.max(0, params.absorption_threshold ?? 3),
		confirmation_location: clamp(params.confirmation_location ?? 0.7, 0.5, 0.99),
	};
}

export const absorptive_wick_decay_wave: Strategy = {
	name: "Absorptive Wick Decay Wave",
	description: "Tracks a decayed wick-absorption wave and enters only when the confirming close exits the imbalance regime.",
	defaultParams: {
		decay_factor: 0.85,
		absorption_threshold: 3,
		confirmation_location: 0.7,
	},
	paramLabels: {
		decay_factor: "Decay Factor",
		absorption_threshold: "Absorption Threshold",
		confirmation_location: "Confirmation Location",
	},
	normalizeParams: normalizeAbsorptiveWickDecayWaveParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 2) return [];

		const decayFactor = clamp(params.decay_factor ?? 0.85, 0.01, 0.999);
		const absorptionThreshold = Math.max(0, params.absorption_threshold ?? 3);
		const confirmationLocation = clamp(params.confirmation_location ?? 0.7, 0.5, 0.99);
		const bearishConfirmationLocation = 1 - confirmationLocation;
		const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
		const absorptionWave = buildCumulativeDecaySum(wickImbalance.map((value) => -value), decayFactor);
		const signals: Signal[] = [];

		for (let i = 0; i < cleanData.length; i++) {
			const metrics = getPriceActionBarMetrics(cleanData[i]);
			const wave = absorptionWave[i];

			if (
				wave <= -absorptionThreshold &&
				metrics.closeLocation >= confirmationLocation &&
				cleanData[i].close > cleanData[i].open
			) {
				signals.push(createBuySignal(cleanData, i, "Absorptive wick decay bullish wave"));
			} else if (
				wave >= absorptionThreshold &&
				metrics.closeLocation <= bearishConfirmationLocation &&
				cleanData[i].close < cleanData[i].open
			) {
				signals.push(createSellSignal(cleanData, i, "Absorptive wick decay bearish wave"));
			}
		}

		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["decay_factor", "absorption_threshold", "confirmation_location"],
	},
};
