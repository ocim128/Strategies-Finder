import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeBodyDirectionRhythmicCycleBreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		autoCorrWindow: Math.max(3, Math.round(params.autoCorrWindow ?? 40)),
		cycleLag: Math.max(1, Math.round(params.cycleLag ?? 5)) };
}

export const body_direction_rhythmic_cycle_break: Strategy = {
	name: "Body Direction Rhythmic Cycle Break",
	description: "Autocorrelation of body direction at higher lags detects rhythmic dealer hedging cycles. When the rhythm breaks (autocorrelation collapses), the dealer program has been disrupted or completed. Enter in the direction of the first bar free from the cycle.",
	defaultParams: {
		autoCorrWindow: 40,
		cycleLag: 5 },
	paramLabels: {
		autoCorrWindow: "Autocorrelation Window",
		cycleLag: "Cycle Lag" },
	normalizeParams: normalizeBodyDirectionRhythmicCycleBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodyDirectionRhythmicCycleBreakParams(params);
		const autoCorrWindow = p.autoCorrWindow as number;
		const cycleLag = p.cycleLag as number;
		if (cleanData.length < autoCorrWindow + cycleLag + 2) return [];

		const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
		const cycleAutocorr = buildRollingAutoCorrelation(bodyDir, autoCorrWindow, cycleLag);

		return createSignalLoop(cleanData, [cycleAutocorr], (i) => {
			if (i < autoCorrWindow + cycleLag + 1) return null;
			const priorAc = cycleAutocorr[i - 1];
			const currAc = cycleAutocorr[i];
			if (priorAc === null || currAc === null) return null;

			if (priorAc > 0.3 && currAc <= 0) {
				if (bodyDir[i] > 0) {
					return createBuySignal(cleanData, i, `Cycle autocorrelation (lag=${cycleLag}) broke from ${priorAc.toFixed(2)} to ${currAc.toFixed(2)}, body bullish`);
				}
				if (bodyDir[i] < 0) {
					return createSellSignal(cleanData, i, `Cycle autocorrelation (lag=${cycleLag}) broke from ${priorAc.toFixed(2)} to ${currAc.toFixed(2)}, body bearish`);
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["autoCorrWindow", "cycleLag"] } };
