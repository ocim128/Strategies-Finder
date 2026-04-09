import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildRollingAverage, buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeInitiativePressurePhiExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pressure_lookback: Math.max(2, Math.round(params.pressure_lookback ?? 20)),
		pressure_phi: Math.max(0.01, Number(params.pressure_phi ?? 0.382)),
	};
}

export const initiative_pressure_phi_exhaustion: Strategy = {
	name: "Initiative Pressure Phi Exhaustion",
	description: "If rolling initiative pressure drops below 0.382 while price makes new extremes, aggressive liquidity has dried up, leaving a vacuum for reversal.",
	defaultParams: {
		pressure_lookback: 20,
		pressure_phi: 0.382,
	},
	paramLabels: {
		pressure_lookback: "Pressure Lookback",
		pressure_phi: "Pressure Phi",
	},
	normalizeParams: normalizeInitiativePressurePhiExhaustionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativePressurePhiExhaustionParams(params);
		if (cleanData.length < p.pressure_lookback) return [];

		const closes = getCloses(cleanData);
		const pressure = buildInitiativePressureSeries(cleanData, p.pressure_lookback);
		const pressureClean = pressure.map(v => v ?? 0);
		const smoothPressure = buildRollingAverage(pressureClean, p.pressure_lookback);
		const { highest, lowest } = buildTrailingHighLow(cleanData, p.pressure_lookback);

		return createSignalLoop(cleanData, [smoothPressure, highest, lowest], (i) => {
			if (i < p.pressure_lookback) return null;
			const sp = smoothPressure[i];
			const trailHigh = highest[i];
			const trailLow = lowest[i];
			if (sp === null || trailHigh === null || trailLow === null) return null;

			if (closes[i] <= trailLow && sp > -p.pressure_phi)
				return createBuySignal(cleanData, i, "Sellers exhausted at new low");
			if (closes[i] >= trailHigh && sp < p.pressure_phi)
				return createSellSignal(cleanData, i, "Buyers exhausted at new high");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pressure_lookback", "pressure_phi"],
	},
};
