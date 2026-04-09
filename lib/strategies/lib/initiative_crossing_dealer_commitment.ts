import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildThresholdCrossingCount } from "./price-action-statistics-core";

function normalizeInitiativeCrossingDealerCommitmentParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		crossingWindow: Math.max(2, Math.round(params.crossingWindow ?? 25)),
		maxCrossings: Math.max(0, Math.round(params.maxCrossings ?? 8)) };
}

export const initiative_crossing_dealer_commitment: Strategy = {
	name: "Initiative Crossing Dealer Commitment",
	description: "Counts zero-crossings of initiative pressure within a rolling window to measure dealer directional indecision. When the crossing count collapses from elevated to low, dealers have stopped oscillating and committed to a direction. Enter in the direction of the current initiative pressure.",
	defaultParams: {
		crossingWindow: 25,
		maxCrossings: 8 },
	paramLabels: {
		crossingWindow: "Crossing Window",
		maxCrossings: "Max Crossings" },
	normalizeParams: normalizeInitiativeCrossingDealerCommitmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativeCrossingDealerCommitmentParams(params);
		const crossingWindow = p.crossingWindow as number;
		const maxCrossings = p.maxCrossings as number;
		if (cleanData.length < crossingWindow + 2) return [];

		const ipSeries = buildInitiativePressureSeries(cleanData, crossingWindow);
		const ipClean = ipSeries.map(v => v ?? 0);
		const crossingCount = buildThresholdCrossingCount(ipClean, crossingWindow, 0);

		return createSignalLoop(cleanData, [crossingCount], (i) => {
			if (i < crossingWindow + 1) return null;
			const priorCrossings = crossingCount[i - 1];
			const currCrossings = crossingCount[i];
			if (priorCrossings === null || currCrossings === null) return null;

			if (priorCrossings > maxCrossings && currCrossings <= maxCrossings) {
				if (ipClean[i] > 0) {
					return createBuySignal(cleanData, i, `Initiative crossing count collapsed (${currCrossings}), IP committed bullish`);
				}
				if (ipClean[i] < 0) {
					return createSellSignal(cleanData, i, `Initiative crossing count collapsed (${currCrossings}), IP committed bearish`);
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["crossingWindow", "maxCrossings"] } };
