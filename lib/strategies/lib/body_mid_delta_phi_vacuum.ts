import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeBodyMidDeltaPhiVacuumParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		atr_lookback: Math.max(2, Math.round(params.atr_lookback ?? 14)),
		phi_shift: Math.max(0.01, Math.abs(Number(params.phi_shift ?? 0.382))),
		pressure_ceiling: Math.max(0.01, Math.abs(Number(params.pressure_ceiling ?? 0.5))) };
}

export const body_mid_delta_phi_vacuum: Strategy = {
	name: "Body Mid Delta Phi Vacuum",
	description: "If the body midpoint shifts by the golden ratio of rolling ATR but initiative pressure remains dead, price has fallen into an orderbook vacuum and will snap back to equilibrium.",
	defaultParams: {
		atr_lookback: 14,
		phi_shift: 0.382,
		pressure_ceiling: 0.5 },
	paramLabels: {
		atr_lookback: "ATR Lookback",
		phi_shift: "Phi Shift",
		pressure_ceiling: "Pressure Ceiling" },
	normalizeParams: normalizeBodyMidDeltaPhiVacuumParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodyMidDeltaPhiVacuumParams(params);
		if (cleanData.length < p.atr_lookback) return [];

		const bodyMidDelta = extractBarMetricSeries(cleanData, "bodyMidDelta");
		const trueRange = extractBarMetricSeries(cleanData, "trueRange");
		const smoothedTR = buildRollingAverage(trueRange, p.atr_lookback);
		const pressure = buildInitiativePressureSeries(cleanData, p.atr_lookback);

		return createSignalLoop(cleanData, [smoothedTR, pressure], (i) => {
			const atr = smoothedTR[i];
			const press = pressure[i];
			if (atr === null || atr <= 0 || press === null) return null;

			if (Math.abs(press) >= p.pressure_ceiling) return null;

			const threshold = atr * p.phi_shift;

			if (bodyMidDelta[i] < -threshold) {
				return createBuySignal(cleanData, i, `Body mid delta ${bodyMidDelta[i].toFixed(4)} < -phi * ATR, vacuum snap back`);
			}
			if (bodyMidDelta[i] > threshold) {
				return createSellSignal(cleanData, i, `Body mid delta ${bodyMidDelta[i].toFixed(4)} > phi * ATR, vacuum snap back`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["atr_lookback", "phi_shift", "pressure_ceiling"] } };
