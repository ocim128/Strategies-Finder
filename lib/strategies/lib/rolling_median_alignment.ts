import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeRollingMedianAlignmentParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))) };
}

export const rolling_median_alignment: Strategy = {
	name: "Rolling Median Alignment",
	description: "Compares the daily close to a trailing rolling median of closes, generating alignment signals when price deviates from the recent multi-week to multi-month central tendency.",
	defaultParams: {
		lookback: 63 },
	paramLabels: {
		lookback: "Lookback" },
	normalizeParams: normalizeRollingMedianAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRollingMedianAlignmentParams(params);
		const lookback = p.lookback as number;
		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const median = buildRollingMedian(closes, lookback);

		return createSignalLoop(cleanData, [median], (i) => {
			const m = median[i];
			if (m === null) return null;

			if (closes[i] > m) {
				return createBuySignal(cleanData, i, `Close ${closes[i].toFixed(2)} above rolling median ${m.toFixed(2)}`);
			}
			if (closes[i] < m) {
				return createSellSignal(cleanData, i, `Close ${closes[i].toFixed(2)} below rolling median ${m.toFixed(2)}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"] } };
