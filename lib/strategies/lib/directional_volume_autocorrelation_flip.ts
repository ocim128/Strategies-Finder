import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeDirectionalVolumeAutocorrelationFlipParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		autoCorrWindow: Math.max(3, Math.round(params.autoCorrWindow ?? 20)),
		minAbsAutocorr: Math.max(0, Math.abs(Number(params.minAbsAutocorr ?? 0.15))) };
}

export const directional_volume_autocorrelation_flip: Strategy = {
	name: "Directional Volume Autocorrelation Flip",
	description: "Decomposing volume by bar direction and computing autocorrelation reveals whether aggressive participation is persistent or oscillating. When this autocorrelation crosses zero, the dealer participation regime has shifted. Enter in the direction confirmed by close location.",
	defaultParams: {
		autoCorrWindow: 20,
		minAbsAutocorr: 0.15 },
	paramLabels: {
		autoCorrWindow: "Autocorrelation Window",
		minAbsAutocorr: "Min |Autocorrelation|" },
	normalizeParams: normalizeDirectionalVolumeAutocorrelationFlipParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDirectionalVolumeAutocorrelationFlipParams(params);
		const autoCorrWindow = p.autoCorrWindow as number;
		const minAbsAutocorr = p.minAbsAutocorr as number;
		if (cleanData.length < autoCorrWindow + 2) return [];

		const dirVol = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			if (cleanData[i].close > cleanData[i].open) dirVol[i] = cleanData[i].volume;
			else if (cleanData[i].close < cleanData[i].open) dirVol[i] = -cleanData[i].volume;
		}

		const autocorr = buildRollingAutoCorrelation(dirVol, autoCorrWindow);
		const closeLoc = buildCloseLocationSeries(cleanData);

		return createSignalLoop(cleanData, [autocorr], (i) => {
			if (i < autoCorrWindow + 1) return null;
			const priorAc = autocorr[i - 1];
			const currAc = autocorr[i];
			if (priorAc === null || currAc === null) return null;

			if (Math.abs(priorAc) < minAbsAutocorr) return null;

			if (priorAc > 0 && currAc <= 0 && closeLoc[i] > 0.5) {
				return createBuySignal(cleanData, i, `Dir-vol autocorr flipped positive→negative (${priorAc.toFixed(2)}→${currAc.toFixed(2)}), close location bullish`);
			}
			if (priorAc > 0 && currAc <= 0 && closeLoc[i] < 0.5) {
				return createSellSignal(cleanData, i, `Dir-vol autocorr flipped positive→negative (${priorAc.toFixed(2)}→${currAc.toFixed(2)}), close location bearish`);
			}
			if (priorAc < 0 && currAc >= 0 && closeLoc[i] > 0.5) {
				return createBuySignal(cleanData, i, `Dir-vol autocorr flipped negative→positive (${priorAc.toFixed(2)}→${currAc.toFixed(2)}), close location bullish`);
			}
			if (priorAc < 0 && currAc >= 0 && closeLoc[i] < 0.5) {
				return createSellSignal(cleanData, i, `Dir-vol autocorr flipped negative→positive (${priorAc.toFixed(2)}→${currAc.toFixed(2)}), close location bearish`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["autoCorrWindow", "minAbsAutocorr"] } };
