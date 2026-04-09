import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeCloseAcceptanceAutoReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		autocorrWindow: Math.max(3, Math.round(params.autocorrWindow ?? 20)) };
}

export const close_acceptance_auto_reversion: Strategy = {
	name: "Close Acceptance Auto-Reversion",
	description: "When autocorrelation of close acceptance is strongly negative, the market oscillates predictably between closes at highs and lows. After acceptance at one extreme, entry is favored in the opposite direction.",
	defaultParams: {
		autocorrWindow: 20 },
	paramLabels: {
		autocorrWindow: "Autocorrelation Window" },
	normalizeParams: normalizeCloseAcceptanceAutoReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseAcceptanceAutoReversionParams(params);
		if (cleanData.length < p.autocorrWindow) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const autocorr = buildRollingAutoCorrelation(acceptance, p.autocorrWindow);

		return createSignalLoop(cleanData, [autocorr], (i) => {
			if (i < p.autocorrWindow) return null;
			const ac = autocorr[i];
			if (ac === null) return null;

			if (ac < -0.3 && acceptance[i] < -0.3) {
				return createBuySignal(cleanData, i, `Acceptance AC ${ac.toFixed(3)} < -0.3, acceptance ${acceptance[i].toFixed(3)} at low extreme, oscillation predicts up`);
			}
			if (ac < -0.3 && acceptance[i] > 0.3) {
				return createSellSignal(cleanData, i, `Acceptance AC ${ac.toFixed(3)} < -0.3, acceptance ${acceptance[i].toFixed(3)} at high extreme, oscillation predicts down`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["autocorrWindow"] } };
