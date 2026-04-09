import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingMedian, buildThresholdCrossingCount } from "./price-action-statistics-core";

function normalizeThresholdCrossingVolatilityShiftParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		max_crossings: Math.max(0, Math.round(params.max_crossings ?? 3)) };
}

export const threshold_crossing_volatility_shift: Strategy = {
	name: "Threshold Crossing Volatility Shift",
	description: "A high crossing count over the rolling median indicates chop; a sudden plunge in crossings signals boundary levels are now respected, confirming a structural breakout.",
	defaultParams: {
		lookback: 20,
		max_crossings: 3 },
	paramLabels: {
		lookback: "Lookback",
		max_crossings: "Max Crossings" },
	normalizeParams: normalizeThresholdCrossingVolatilityShiftParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeThresholdCrossingVolatilityShiftParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const median = buildRollingMedian(closes, p.lookback);
		const medianValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			medianValues[i] = median[i] ?? closes[i];
		}

		const crossingCount = buildThresholdCrossingCount(closes, p.lookback, 0);

		const { highest, lowest } = buildTrailingHighLow(cleanData, p.lookback);

		return createSignalLoop(cleanData, [crossingCount, highest, lowest], (i) => {
			if (i < 1 || i < p.lookback) return null;
			const cc = crossingCount[i];
			if (cc === null) return null;

			if (cc >= p.max_crossings) return null;

			const prevHi = highest[i - 1];
			const prevLo = lowest[i - 1];
			if (prevHi === null || prevLo === null) return null;

			if (closes[i] > prevHi) {
				return createBuySignal(cleanData, i, `Crossings ${cc} < ${p.max_crossings}, broke above trailing high`);
			}
			if (closes[i] < prevLo) {
				return createSellSignal(cleanData, i, `Crossings ${cc} < ${p.max_crossings}, broke below trailing low`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "max_crossings"] } };
