import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeCloseAcceptancePhiPolarizationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		streak_len: Math.max(1, Math.round(params.streak_len ?? 4)),
		phi_deviation: Math.max(0.01, Math.min(0.49, Number(params.phi_deviation ?? 0.382))) };
}

export const close_acceptance_phi_polarization: Strategy = {
	name: "Close Acceptance Phi Polarization",
	description: "A consecutive streak where Close Acceptance deviates beyond the golden ratio from neutral perfectly isolates a structural value polarization that traps late participants.",
	defaultParams: {
		streak_len: 4,
		phi_deviation: 0.382 },
	paramLabels: {
		streak_len: "Streak Length",
		phi_deviation: "Phi Deviation" },
	normalizeParams: normalizeCloseAcceptancePhiPolarizationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseAcceptancePhiPolarizationParams(params);
		const minWarmup = p.streak_len + 1;
		if (cleanData.length < minWarmup) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const lowerBound = 0.5 - p.phi_deviation;
		const upperBound = 0.5 + p.phi_deviation;

		const bearishFlags = new Array(cleanData.length).fill(0);
		const bullishFlags = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			if (acceptance[i] < lowerBound) bearishFlags[i] = -1;
			if (acceptance[i] > upperBound) bullishFlags[i] = 1;
		}

		const bearishStreaks = buildStreakCount(bearishFlags);
		const bullishStreaks = buildStreakCount(bullishFlags);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1) return null;

			if (bearishStreaks[i - 1] <= -p.streak_len && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, `Bearish acceptance streak ${Math.abs(bearishStreaks[i - 1])} >= ${p.streak_len}, snapped bullish`);
			}
			if (bullishStreaks[i - 1] >= p.streak_len && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, `Bullish acceptance streak ${bullishStreaks[i - 1]} >= ${p.streak_len}, snapped bearish`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["streak_len", "phi_deviation"] } };
