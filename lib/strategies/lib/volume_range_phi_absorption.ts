import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingCorrelation } from "./price-action-statistics-core";

function normalizeVolumeRangePhiAbsorptionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		corr_lookback: Math.max(3, Math.round(params.corr_lookback ?? 20)),
		phi_correlation: -Math.abs(Number(params.phi_correlation ?? -0.382)) };
}

export const volume_range_phi_absorption: Strategy = {
	name: "Volume Range Phi Absorption",
	description: "A strongly negative correlation between True Range and Volume proves limit-order absorption — higher volume is producing tighter ranges, indicating one side is being systematically absorbed.",
	defaultParams: {
		corr_lookback: 20,
		phi_correlation: -0.382 },
	paramLabels: {
		corr_lookback: "Correlation Lookback",
		phi_correlation: "Phi Correlation" },
	normalizeParams: normalizeVolumeRangePhiAbsorptionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeRangePhiAbsorptionParams(params);
		if (cleanData.length < p.corr_lookback) return [];

		const trueRange = extractBarMetricSeries(cleanData, "trueRange");
		const volumes = getVolumes(cleanData);
		const correlation = buildRollingCorrelation(trueRange, volumes, p.corr_lookback);

		return createSignalLoop(cleanData, [correlation], (i) => {
			if (i < p.corr_lookback) return null;
			const corr = correlation[i];
			if (corr === null) return null;

			const bearishBar = cleanData[i].close < cleanData[i].open;

			if (corr < p.phi_correlation && bearishBar) {
				return createBuySignal(cleanData, i, `TR-Vol corr ${corr.toFixed(3)} < phi, sellers being absorbed`);
			}
			if (corr < p.phi_correlation && !bearishBar) {
				return createSellSignal(cleanData, i, `TR-Vol corr ${corr.toFixed(3)} < phi, buyers being absorbed`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["corr_lookback", "phi_correlation"] } };
