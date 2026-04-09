import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingKurtosis, buildRollingMedian } from "./price-action-statistics-core";

function normalizeKurtosisInitiativePhiExpansionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(4, Math.round(params.lookback ?? 30)),
		phi_kurtosis: Math.max(0.01, Math.abs(Number(params.phi_kurtosis ?? 0.382))) };
}

export const kurtosis_initiative_phi_expansion: Strategy = {
	name: "Kurtosis Initiative Phi Expansion",
	description: "Aggressive order flow breaking into a new regime is only valid if the rolling kurtosis of Initiative Pressure collapses below phi, proving the flow is sustained broad-based participation, not a random tail event.",
	defaultParams: {
		lookback: 30,
		phi_kurtosis: 0.382 },
	paramLabels: {
		lookback: "Lookback",
		phi_kurtosis: "Phi Kurtosis" },
	normalizeParams: normalizeKurtosisInitiativePhiExpansionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeKurtosisInitiativePhiExpansionParams(params);
		if (cleanData.length < p.lookback) return [];

		const pressure = buildInitiativePressureSeries(cleanData, p.lookback);
		const pressureValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			pressureValues[i] = pressure[i] ?? 0;
		}
		const kurtosis = buildRollingKurtosis(pressureValues, p.lookback);
		const median = buildRollingMedian(pressureValues, p.lookback);

		return createSignalLoop(cleanData, [kurtosis, median], (i) => {
			if (i < p.lookback) return null;
			const k = kurtosis[i];
			const med = median[i];
			if (k === null || med === null) return null;

			const pressureNow = pressureValues[i];

			if (k < p.phi_kurtosis && pressureNow > med && med > 0) {
				return createBuySignal(cleanData, i, `Kurtosis ${k.toFixed(3)} < phi, pressure ${pressureNow.toFixed(3)} > median ${med.toFixed(3)} > 0`);
			}
			if (k < p.phi_kurtosis && pressureNow < med && med < 0) {
				return createSellSignal(cleanData, i, `Kurtosis ${k.toFixed(3)} < phi, pressure ${pressureNow.toFixed(3)} < median ${med.toFixed(3)} < 0`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_kurtosis"] } };
