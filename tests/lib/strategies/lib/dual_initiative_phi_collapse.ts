import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeDualInitiativePhiCollapseParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fast_lookback: Math.max(2, Math.round(params.fast_lookback ?? 5)),
		slow_lookback: Math.max(3, Math.round(params.slow_lookback ?? 30)),
		phi_ratio: Math.max(0.01, Math.abs(Number(params.phi_ratio ?? 0.382))) };
}

export const dual_initiative_phi_collapse: Strategy = {
	name: "Dual Initiative Phi Collapse",
	description: "When the fast rolling average of initiative pressure collapses below the golden ratio of the slow average, micro aggressive flow has instantly dried up against the macro trend, mapping a structural pullback.",
	defaultParams: {
		fast_lookback: 5,
		slow_lookback: 30,
		phi_ratio: 0.382 },
	paramLabels: {
		fast_lookback: "Fast Lookback",
		slow_lookback: "Slow Lookback",
		phi_ratio: "Phi Ratio" },
	normalizeParams: normalizeDualInitiativePhiCollapseParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDualInitiativePhiCollapseParams(params);
		if (cleanData.length < p.slow_lookback) return [];

		const flowLookback = Math.max(p.fast_lookback, p.slow_lookback);
		const pressure = buildInitiativePressureSeries(cleanData, flowLookback);
		const pressureValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			pressureValues[i] = pressure[i] ?? 0;
		}
		const fastAvg = buildRollingAverage(pressureValues, p.fast_lookback);
		const slowAvg = buildRollingAverage(pressureValues, p.slow_lookback);

		return createSignalLoop(cleanData, [fastAvg, slowAvg], (i) => {
			const fast = fastAvg[i];
			const slow = slowAvg[i];
			if (fast === null || slow === null) return null;

			if (slow > 0 && fast > 0 && fast < slow * p.phi_ratio) {
				return createBuySignal(cleanData, i, `Fast ${(fast as number).toFixed(3)} < phi * slow ${(slow as number).toFixed(3)}, bullish micro collapse`);
			}
			if (slow < 0 && fast < 0 && fast > slow * p.phi_ratio) {
				return createSellSignal(cleanData, i, `Fast ${(fast as number).toFixed(3)} > phi * slow ${(slow as number).toFixed(3)}, bearish micro collapse`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fast_lookback", "slow_lookback", "phi_ratio"] } };
