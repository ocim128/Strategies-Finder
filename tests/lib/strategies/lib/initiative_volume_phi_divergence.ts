import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingCorrelation, buildRateOfChange } from "./price-action-statistics-core";

function normalizeInitiativeVolumePhiDivergenceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		corr_lookback: Math.max(3, Math.round(params.corr_lookback ?? 20)),
		phi_divergence: -Math.abs(Number(params.phi_divergence ?? -0.382)) };
}

export const initiative_volume_phi_divergence: Strategy = {
	name: "Initiative Volume Phi Divergence",
	description: "When rolling correlation between initiative pressure and total volume drops below -0.382, rising volume is being met with opposing limit orders, perfectly absorbing the momentum.",
	defaultParams: {
		corr_lookback: 20,
		phi_divergence: -0.382 },
	paramLabels: {
		corr_lookback: "Correlation Lookback",
		phi_divergence: "Phi Divergence" },
	normalizeParams: normalizeInitiativeVolumePhiDivergenceParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativeVolumePhiDivergenceParams(params);
		if (cleanData.length < p.corr_lookback) return [];

		const pressure = buildInitiativePressureSeries(cleanData, p.corr_lookback);
		const pressureValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			pressureValues[i] = pressure[i] ?? 0;
		}
		const volumes = getVolumes(cleanData);
		const correlation = buildRollingCorrelation(pressureValues, volumes, p.corr_lookback);
		const closes = cleanData.map(d => d.close);
		const roc = buildRateOfChange(closes, p.corr_lookback);

		return createSignalLoop(cleanData, [correlation, roc], (i) => {
			if (i < p.corr_lookback) return null;
			const corr = correlation[i];
			const rocVal = roc[i];
			if (corr === null || rocVal === null) return null;

			if (corr < p.phi_divergence && rocVal < 0) {
				return createBuySignal(cleanData, i, `Pressure-Vol corr ${corr.toFixed(3)} < phi, aggressive selling absorbed`);
			}
			if (corr < p.phi_divergence && rocVal > 0) {
				return createSellSignal(cleanData, i, `Pressure-Vol corr ${corr.toFixed(3)} < phi, aggressive buying absorbed`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["corr_lookback", "phi_divergence"] } };
