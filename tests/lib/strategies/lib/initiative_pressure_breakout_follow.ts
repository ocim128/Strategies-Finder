import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
		pressureThreshold: Math.max(0.01, Number(params.pressureThreshold ?? 0.65)),
	};
}

export const initiative_pressure_breakout_follow: Strategy = {
	name: "Initiative Pressure Breakout Follow",
	description: "Follows the breakout when the rolling average of initiative pressure breaks out above a high threshold, backed by high relative volume.",
	defaultParams: {
		lookback: 35,
		pressureThreshold: 0.65,
	},
	paramLabels: {
		lookback: "Lookback Window",
		pressureThreshold: "Pressure Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const pressureThreshold = p.pressureThreshold as number;
		if (cleanData.length < lookback * 2) return [];

		const volumes = getVolumes(cleanData);
		const volPercentile = buildPercentileRank(volumes, lookback);

		const pressure = buildInitiativePressureSeries(cleanData, lookback);
		const cleanPressure = pressure.map(v => v !== null ? v : 0);
		const avgPressure = buildRollingAverage(cleanPressure, lookback);

		const closeLocation = buildCloseLocationSeries(cleanData);

		return createSignalLoop(cleanData, [avgPressure, volPercentile], (i) => {
			if (i < lookback * 2) return null;
			const ap = avgPressure[i];
			const vp = volPercentile[i];
			const cl = closeLocation[i];
			if (ap === null || vp === null || cl === null) return null;

			if (vp <= 0.70) return null;

			if (ap > pressureThreshold && cl > 0.70) {
				return createBuySignal(cleanData, i, `Initiative pressure avg (${ap.toFixed(2)}) > ${pressureThreshold}, volume percentile (${vp.toFixed(2)}) > 0.70, close location ${cl.toFixed(2)} > 0.70`);
			}
			if (ap < -pressureThreshold && cl < 0.30) {
				return createSellSignal(cleanData, i, `Initiative pressure avg (${ap.toFixed(2)}) < -${pressureThreshold}, volume percentile (${vp.toFixed(2)}) > 0.70, close location ${cl.toFixed(2)} < 0.30`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "pressureThreshold"],
	},
};
