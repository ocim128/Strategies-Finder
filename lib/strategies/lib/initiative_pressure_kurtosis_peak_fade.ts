import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingKurtosis, buildRollingMinMax } from "./price-action-statistics-core";

function normalizeInitiativePressureKurtosisPeakFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		kurtosisWindow: Math.max(4, Math.round(params.kurtosisWindow ?? 50)),
		kurtosisThreshold: Math.max(0, Math.abs(Number(params.kurtosisThreshold ?? 5.0))) };
}

export const initiative_pressure_kurtosis_peak_fade: Strategy = {
	name: "Initiative Pressure Kurtosis Peak Fade",
	description: "Rolling kurtosis of initiative pressure measures fat-tailed aggression. A kurtosis spike means extreme dealer events occurred. When kurtosis peaks and declines, the outlier event is over. Fade the direction of the dominant initiative extreme within the window.",
	defaultParams: {
		kurtosisWindow: 50,
		kurtosisThreshold: 5.0 },
	paramLabels: {
		kurtosisWindow: "Kurtosis Window",
		kurtosisThreshold: "Kurtosis Threshold" },
	normalizeParams: normalizeInitiativePressureKurtosisPeakFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativePressureKurtosisPeakFadeParams(params);
		const kurtosisWindow = p.kurtosisWindow as number;
		const kurtosisThreshold = p.kurtosisThreshold as number;
		if (cleanData.length < kurtosisWindow + 2) return [];

		const ipSeries = buildInitiativePressureSeries(cleanData, kurtosisWindow);
		const ipClean = ipSeries.map(v => v ?? 0);
		const kurt = buildRollingKurtosis(ipClean, kurtosisWindow);
		const mm = buildRollingMinMax(ipClean, kurtosisWindow);

		return createSignalLoop(cleanData, [kurt], (i) => {
			if (i < kurtosisWindow + 1) return null;
			const priorKurt = kurt[i - 1];
			const currKurt = kurt[i];
			if (priorKurt === null || currKurt === null) return null;

			if (priorKurt > kurtosisThreshold && currKurt < priorKurt) {
				const minVal = mm.min[i];
				const maxVal = mm.max[i];
				if (minVal === null || maxVal === null) return null;

				if (Math.abs(minVal) > Math.abs(maxVal)) {
					return createBuySignal(cleanData, i, `IP kurtosis peaked (${priorKurt.toFixed(1)}), selling-dominated event fading`);
				}
				if (Math.abs(maxVal) > Math.abs(minVal)) {
					return createSellSignal(cleanData, i, `IP kurtosis peaked (${priorKurt.toFixed(1)}), buying-dominated event fading`);
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["kurtosisWindow", "kurtosisThreshold"] } };
