// @ts-nocheck
import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeClosePercentileRangeEntryParams(params: StrategyParams): StrategyParams {
	const rangeWindow = Math.max(5, Math.round(params.rangeWindow ?? 20));
	const entryPercentile = Math.max(1, Math.min(49, Math.round(params.entryPercentile ?? 10)));
	const confirmationBars = Math.max(1, Math.round(params.confirmationBars ?? 1));

	return {
		...params,
		rangeWindow,
		entryPercentile,
		confirmationBars };
}

export const close_percentile_range_entry: Strategy = {
	name: "Close Percentile Range Entry",
	description: "Close position within rolling high-low range reaches percentile threshold, then entry triggers on first close that exits the percentile zone.",
	defaultParams: {
		rangeWindow: 20,
		entryPercentile: 10,
		confirmationBars: 1 },
	paramLabels: {
		rangeWindow: "Range Window",
		entryPercentile: "Entry Percentile",
		confirmationBars: "Confirmation Bars" },
	normalizeParams: normalizeClosePercentileRangeEntryParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeClosePercentileRangeEntryParams(params);

		if (cleanData.length < normalizedParams.rangeWindow + normalizedParams.confirmationBars) {
			return [];
		}

		const closes = getCloses(cleanData);

		// Compute trailing high/low
		const { highest, lowest } = buildTrailingHighLow(cleanData, normalizedParams.rangeWindow, false);

		// Keep the derived series aligned to source bar indexes.
		const closePercentiles: (number | null)[] = new Array(cleanData.length).fill(null);

		for (let i = normalizedParams.rangeWindow - 1; i < cleanData.length; i++) {
			const high = highest[i];
			const low = lowest[i];
			const close = closes[i];

			if (high === null || low === null || high === low) {
				continue;
			}

			// Position as percentage (0 = low, 100 = high)
			const position = ((close - low) / (high - low)) * 100;
			closePercentiles[i] = position;
		}

		// Track extreme state
		let inLowerExtreme = false;
		let inUpperExtreme = false;
		let exitConfirmCount = 0;

		return createSignalLoop(cleanData, [highest, lowest, closePercentiles], (i) => {
			const high = highest[i];
			const low = lowest[i];
			const percentile = closePercentiles[i];

			if (high === null || low === null || percentile === null) return null;

			const lowerThreshold = normalizedParams.entryPercentile;
			const upperThreshold = 100 - normalizedParams.entryPercentile;

			// Track entry into extreme zones
			if (percentile < lowerThreshold) {
				inLowerExtreme = true;
				exitConfirmCount = 0;
			} else if (percentile > upperThreshold) {
				inUpperExtreme = true;
				exitConfirmCount = 0;
			}

			// Check for exit from extremes
			if (inLowerExtreme) {
				if (percentile > upperThreshold) {
					exitConfirmCount++;
					if (exitConfirmCount >= normalizedParams.confirmationBars) {
						return createBuySignal(cleanData, i, `Percentile Exit Up: ${percentile.toFixed(1)}th percentile`);
					}
				} else {
					exitConfirmCount = 0;
				}
			}

			if (inUpperExtreme) {
				if (percentile < lowerThreshold) {
					exitConfirmCount++;
					if (exitConfirmCount >= normalizedParams.confirmationBars) {
						return createSellSignal(cleanData, i, `Percentile Exit Down: ${percentile.toFixed(1)}th percentile`);
					}
				} else {
					exitConfirmCount = 0;
				}
			}

			// Reset if we return to middle
			if (percentile >= lowerThreshold && percentile <= upperThreshold) {
				inLowerExtreme = false;
				inUpperExtreme = false;
				exitConfirmCount = 0;
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["rangeWindow", "entryPercentile", "confirmationBars"] } };
