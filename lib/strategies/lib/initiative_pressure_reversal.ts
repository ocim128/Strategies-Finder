import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeInitiativePressureReversalParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pressureLookback: Math.max(2, Math.round(params.pressureLookback ?? 20)),
		zLookback: Math.max(3, Math.round(params.zLookback ?? 50)) };
}

export const initiative_pressure_reversal: Strategy = {
	name: "Initiative Pressure Reversal",
	description: "When initiative pressure reaches a Z-score extreme and reverses sign, institutional pressure has exhausted and counter-directional entry is favored.",
	defaultParams: {
		pressureLookback: 20,
		zLookback: 50 },
	paramLabels: {
		pressureLookback: "Pressure Lookback",
		zLookback: "Z-Score Lookback" },
	normalizeParams: normalizeInitiativePressureReversalParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativePressureReversalParams(params);
		if (cleanData.length < p.pressureLookback + p.zLookback) return [];

		const pressure = buildInitiativePressureSeries(cleanData, p.pressureLookback);
		const pressureValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			pressureValues[i] = pressure[i] ?? 0;
		}
		const zscore = buildRollingZScore(pressureValues, p.zLookback);

		return createSignalLoop(cleanData, [zscore], (i) => {
			if (i < 1 || i < p.zLookback) return null;
			const zCurr = zscore[i];
			const zPrev = zscore[i - 1];
			if (zCurr === null || zPrev === null) return null;

			if (zPrev < 0 && zCurr >= 0) {
				return createBuySignal(cleanData, i, `Initiative pressure Z reversed up: ${zPrev.toFixed(2)} -> ${zCurr.toFixed(2)}`);
			}
			if (zPrev > 0 && zCurr <= 0) {
				return createSellSignal(cleanData, i, `Initiative pressure Z reversed down: ${zPrev.toFixed(2)} -> ${zCurr.toFixed(2)}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pressureLookback", "zLookback"] } };
