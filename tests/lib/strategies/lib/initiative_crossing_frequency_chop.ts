import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildThresholdCrossingCount, buildPercentileRank } from "./price-action-statistics-core";

const CROSSING_PERCENTILE_LOOKBACK = 50;
const CROSSING_PERCENTILE_FLOOR = 0.2;

function normalizeInitiativeCrossingFrequencyChopParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pressure_lookback: Math.max(3, Math.round(params.pressure_lookback ?? 20)),
		count_window: Math.max(5, Math.round(params.count_window ?? 30)),
	};
}

export const initiative_crossing_frequency_chop: Strategy = {
	name: "Initiative Crossing Frequency Chop",
	description: "The frequency of initiative pressure zero-crossings measures flow decisiveness. When crossing frequency drops from high to low, the market has committed to a flow direction. The sign of initiative pressure gives the direction.",
	defaultParams: {
		pressure_lookback: 20,
		count_window: 30,
	},
	paramLabels: {
		pressure_lookback: "Pressure Lookback",
		count_window: "Count Window",
	},
	normalizeParams: normalizeInitiativeCrossingFrequencyChopParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativeCrossingFrequencyChopParams(params);
		const pressureLookback = p.pressure_lookback as number;
		const countWindow = p.count_window as number;
		if (cleanData.length < pressureLookback + countWindow + CROSSING_PERCENTILE_LOOKBACK + 2) return [];

		const pressure = buildInitiativePressureSeries(cleanData, pressureLookback);
		const pressureNorm = pressure.map(v => v ?? 0);
		const crossingCount = buildThresholdCrossingCount(pressureNorm, countWindow, 0);
		const crossingNorm = crossingCount.map(v => v ?? 0);
		const crossingPct = buildPercentileRank(crossingNorm, CROSSING_PERCENTILE_LOOKBACK);

		const minWarmup = pressureLookback + countWindow + CROSSING_PERCENTILE_LOOKBACK;

		return createSignalLoop(cleanData, [crossingPct, pressure], (i) => {
			if (i < minWarmup) return null;

			const pct = crossingPct[i];
			const pres = pressure[i];
			if (pct === null || pres === null) return null;

			if (pct >= CROSSING_PERCENTILE_FLOOR) return null;

			if (pres > 0) {
				return createBuySignal(cleanData, i, `Flow committed to buying (crossing pct=${(pct * 100).toFixed(0)}%)`);
			}
			if (pres < 0) {
				return createSellSignal(cleanData, i, `Flow committed to selling (crossing pct=${(pct * 100).toFixed(0)}%)`);
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pressure_lookback", "count_window"],
	},
};





