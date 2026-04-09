import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeInitiativePressureSkewExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
		pressure_z_thresh: Math.max(0.5, Math.abs(Number(params.pressure_z_thresh ?? 2.5))) };
}

export const initiative_pressure_skew_exhaustion: Strategy = {
	name: "Initiative Pressure Skew Exhaustion",
	description: "When short-term initiative pressure hits a statistical Z-score extreme but price closes against the pressure, aggressive liquidity has been fully absorbed by passive limits.",
	defaultParams: {
		lookback: 20,
		pressure_z_thresh: 2.5 },
	paramLabels: {
		lookback: "Lookback",
		pressure_z_thresh: "Pressure Z Threshold" },
	normalizeParams: normalizeInitiativePressureSkewExhaustionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativePressureSkewExhaustionParams(params);
		if (cleanData.length < p.lookback) return [];

		const pressure = buildInitiativePressureSeries(cleanData, p.lookback);
		const pressureValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			pressureValues[i] = pressure[i] ?? 0;
		}
		const zscore = buildRollingZScore(pressureValues, p.lookback);

		return createSignalLoop(cleanData, [zscore], (i) => {
			if (i < p.lookback) return null;
			const z = zscore[i];
			if (z === null) return null;

			if (z < -p.pressure_z_thresh && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, `Initiative Z ${z.toFixed(2)} < -${p.pressure_z_thresh}, aggressive sellers absorbed`);
			}
			if (z > p.pressure_z_thresh && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, `Initiative Z ${z.toFixed(2)} > ${p.pressure_z_thresh}, aggressive buyers absorbed`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "pressure_z_thresh"] } };
