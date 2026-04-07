import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		valueWindow: Math.max(2, Math.round(params.valueWindow ?? 15)),
		shiftThresholdPct: Math.max(0.01, Number(params.shiftThresholdPct ?? 0.5)) };
}

export const value_area_median_shift: Strategy = {
	name: "Value Area Median Shift",
	description: "A raw, sudden shift in the robust rolling median indicates that entire trading zones have migrated.",
	defaultParams: {
		valueWindow: 15,
		shiftThresholdPct: 0.5 },
	paramLabels: {
		valueWindow: "Value Window",
		shiftThresholdPct: "Shift Threshold (%)" },
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const { valueWindow, shiftThresholdPct } = normalizeParams(params);
		if (cleanData.length < valueWindow * 2) return [];

		const closes = getCloses(cleanData);
		const medians = buildRollingMedian(closes, valueWindow);

		return createSignalLoop(cleanData, [medians], (i) => {
			if (i < valueWindow) return null;
			const currMed = medians[i];
			const pastMed = medians[i - valueWindow];

			if (currMed === null || pastMed === null || pastMed === 0) return null;

			const shiftPct = ((currMed - pastMed) / pastMed) * 100;

			if (shiftPct >= shiftThresholdPct) {
				return createBuySignal(cleanData, i, "Bullish Median Shift");
			}
			if (shiftPct <= -shiftThresholdPct) {
				return createSellSignal(cleanData, i, "Bearish Median Shift");
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["valueWindow", "shiftThresholdPct"] } };
