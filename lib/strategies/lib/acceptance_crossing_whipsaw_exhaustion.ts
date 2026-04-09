import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildThresholdCrossingCount } from "./price-action-statistics-core";

function normalizeAcceptanceCrossingWhipsawExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		whipsawWindow: Math.max(2, Math.round(params.whipsawWindow ?? 20)),
		minWhipsawCount: Math.max(0, Math.round(params.minWhipsawCount ?? 6)) };
}

export const acceptance_crossing_whipsaw_exhaustion: Strategy = {
	name: "Acceptance Crossing Whipsaw Exhaustion",
	description: "Counts zero-line crossings of close acceptance within a rolling window to measure dealer directional indecision. When crossing count is extreme, the first bar producing strong acceptance in one direction signals resolved indecision. Enter in that direction.",
	defaultParams: {
		whipsawWindow: 20,
		minWhipsawCount: 6 },
	paramLabels: {
		whipsawWindow: "Whipsaw Window",
		minWhipsawCount: "Min Whipsaw Count" },
	normalizeParams: normalizeAcceptanceCrossingWhipsawExhaustionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeAcceptanceCrossingWhipsawExhaustionParams(params);
		const whipsawWindow = p.whipsawWindow as number;
		const minWhipsawCount = p.minWhipsawCount as number;
		if (cleanData.length < whipsawWindow + 2) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const crossingCount = buildThresholdCrossingCount(acceptance, whipsawWindow, 0);

		return createSignalLoop(cleanData, [crossingCount], (i) => {
			if (i < whipsawWindow + 1) return null;
			const priorCount = crossingCount[i - 1];
			if (priorCount === null || priorCount <= minWhipsawCount) return null;

			if (acceptance[i] > 0.5) {
				return createBuySignal(cleanData, i, `Whipsaw exhaustion (${priorCount} crossings), acceptance resolved bullish (${acceptance[i].toFixed(2)})`);
			}
			if (acceptance[i] < -0.5) {
				return createSellSignal(cleanData, i, `Whipsaw exhaustion (${priorCount} crossings), acceptance resolved bearish (${acceptance[i].toFixed(2)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["whipsawWindow", "minWhipsawCount"] } };
