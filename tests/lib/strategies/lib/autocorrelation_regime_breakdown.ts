import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingAutoCorrelation, buildRateOfChange } from "./price-action-statistics-core";

function normalizeAutocorrelationRegimeBreakdownParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 30)),
		acf_max: Number(params.acf_max ?? 0) };
}

export const autocorrelation_regime_breakdown: Strategy = {
	name: "Autocorrelation Regime Breakdown",
	description: "When rolling autocorrelation crashes below zero, the directional regime has structurally broken, predicting a sharp mean reversion.",
	defaultParams: {
		lookback: 30,
		acf_max: 0 },
	paramLabels: {
		lookback: "Lookback",
		acf_max: "ACF Breakdown Threshold" },
	normalizeParams: normalizeAutocorrelationRegimeBreakdownParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeAutocorrelationRegimeBreakdownParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const autocorr = buildRollingAutoCorrelation(closes, p.lookback);
		const roc = buildRateOfChange(closes, p.lookback);

		return createSignalLoop(cleanData, [autocorr, roc], (i) => {
			if (i < 1 || i < p.lookback) return null;
			const acCurr = autocorr[i];
			const acPrev = autocorr[i - 1];
			const rocVal = roc[i];
			if (acCurr === null || acPrev === null || rocVal === null) return null;

			if (acPrev >= p.acf_max && acCurr < p.acf_max && rocVal < 0) {
				return createBuySignal(cleanData, i, `Autocorr crossed below ${p.acf_max}: ${acPrev.toFixed(3)} -> ${acCurr.toFixed(3)}, downtrend exhausted`);
			}
			if (acPrev >= p.acf_max && acCurr < p.acf_max && rocVal > 0) {
				return createSellSignal(cleanData, i, `Autocorr crossed below ${p.acf_max}: ${acPrev.toFixed(3)} -> ${acCurr.toFixed(3)}, uptrend exhausted`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "acf_max"] } };
