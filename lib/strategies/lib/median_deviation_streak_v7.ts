import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	const medianLookback = Math.max(2, Math.round(params.medianLookback ?? 20));
	return { ...params, medianLookback };
}

export const median_deviation_streak_v7: Strategy = {
	name: "Median Deviation Streak V7",
	description:
		"Simplified: fires directly when close is above or below the rolling median. No streak counting — just pure median position.",
	defaultParams: {
		medianLookback: 117 },
	paramLabels: {
		medianLookback: "Median Lookback" },
	normalizeParams: normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const medianLookback = p.medianLookback as number;

		if (cleanData.length < medianLookback) return [];

		const closes = getCloses(cleanData);
		const medians = buildRollingMedian(closes, medianLookback);

		return createSignalLoop(cleanData, [], (i) => {
			const med = medians[i];
			if (med === null) return null;

			if (closes[i] > med) {
				return createBuySignal(cleanData, i, `Close > Median(${medianLookback})`);
			}
			if (closes[i] < med) {
				return createSellSignal(cleanData, i, `Close < Median(${medianLookback})`);
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["medianLookback"] } };
