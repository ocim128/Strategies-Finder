import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

function normalizeInitiativeDecayPhiReboundParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pressure_lookback: Math.max(1, Math.round(params.pressure_lookback ?? 10)),
		phi_decay: Math.max(0.01, Math.min(0.999, Number(params.phi_decay ?? 0.382))) };
}

export const initiative_decay_phi_rebound: Strategy = {
	name: "Initiative Decay Phi Rebound",
	description: "Running initiative pressure through a rigid golden-ratio decay creates an incredibly smooth curve that only crosses zero when the structural auction has truly shifted regime.",
	defaultParams: {
		pressure_lookback: 10,
		phi_decay: 0.382 },
	paramLabels: {
		pressure_lookback: "Pressure Lookback",
		phi_decay: "Phi Decay" },
	normalizeParams: normalizeInitiativeDecayPhiReboundParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativeDecayPhiReboundParams(params);
		if (cleanData.length < p.pressure_lookback + 1) return [];

		const pressure = buildInitiativePressureSeries(cleanData, p.pressure_lookback);
		const pressureValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			pressureValues[i] = pressure[i] ?? 0;
		}
		const decayed = buildCumulativeDecaySum(pressureValues, p.phi_decay);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1) return null;

			const prev = decayed[i - 1];
			const curr = decayed[i];

			if (prev <= 0 && curr > 0) {
				return createBuySignal(cleanData, i, `Decayed initiative crossed above zero: ${prev.toFixed(3)} -> ${curr.toFixed(3)}`);
			}
			if (prev >= 0 && curr < 0) {
				return createSellSignal(cleanData, i, `Decayed initiative crossed below zero: ${prev.toFixed(3)} -> ${curr.toFixed(3)}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pressure_lookback", "phi_decay"] } };
