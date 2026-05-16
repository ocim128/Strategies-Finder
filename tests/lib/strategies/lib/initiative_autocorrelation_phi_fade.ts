import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation, buildRateOfChange } from "./price-action-statistics-core";

function normalizeInitiativeAutocorrelationPhiFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		flow_lookback: Math.max(3, Math.round(params.flow_lookback ?? 20)),
		phi_memory_limit: Math.max(0.01, Math.abs(Number(params.phi_memory_limit ?? 0.382))) };
}

export const initiative_autocorrelation_phi_fade: Strategy = {
	name: "Initiative Autocorrelation Phi Fade",
	description: "When rolling autocorrelation of initiative pressure drops below phi, order flow has lost its memory and entered a random state, favoring mean reversion against the immediate price ROC.",
	defaultParams: {
		flow_lookback: 20,
		phi_memory_limit: 0.382 },
	paramLabels: {
		flow_lookback: "Flow Lookback",
		phi_memory_limit: "Phi Memory Limit" },
	normalizeParams: normalizeInitiativeAutocorrelationPhiFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativeAutocorrelationPhiFadeParams(params);
		if (cleanData.length < p.flow_lookback) return [];

		const pressure = buildInitiativePressureSeries(cleanData, p.flow_lookback);
		const pressureValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			pressureValues[i] = pressure[i] ?? 0;
		}
		const autocorr = buildRollingAutoCorrelation(pressureValues, p.flow_lookback);
		const closes = cleanData.map(d => d.close);
		const roc = buildRateOfChange(closes, p.flow_lookback);

		return createSignalLoop(cleanData, [autocorr, roc], (i) => {
			if (i < p.flow_lookback) return null;
			const ac = autocorr[i];
			const rocVal = roc[i];
			if (ac === null || rocVal === null) return null;

			if (ac < p.phi_memory_limit && rocVal < 0) {
				return createBuySignal(cleanData, i, `Initiative autocorr ${ac.toFixed(3)} < phi, fading negative ROC`);
			}
			if (ac < p.phi_memory_limit && rocVal > 0) {
				return createSellSignal(cleanData, i, `Initiative autocorr ${ac.toFixed(3)} < phi, fading positive ROC`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["flow_lookback", "phi_memory_limit"] } };





