import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";

function normalizeRollingMeanAlignmentParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))) };
}

export const rolling_mean_alignment: Strategy = {
	name: "Rolling Mean Alignment",
	description: "Uses the trailing rolling mean of closes as the central anchor, producing long/short signals when the daily close aligns above or below this average price level over multi-month horizons.",
	defaultParams: {
		lookback: 63 },
	paramLabels: {
		lookback: "Lookback" },
	normalizeParams: normalizeRollingMeanAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRollingMeanAlignmentParams(params);
		const lookback = p.lookback as number;
		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const mean = buildRollingAverage(closes, lookback);

		return createSignalLoop(cleanData, [mean], (i) => {
			const m = mean[i];
			if (m === null) return null;

			if (closes[i] > m) {
				return createBuySignal(cleanData, i, `Close ${closes[i].toFixed(2)} above rolling mean ${m.toFixed(2)}`);
			}
			if (closes[i] < m) {
				return createSellSignal(cleanData, i, `Close ${closes[i].toFixed(2)} below rolling mean ${m.toFixed(2)}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"] } };
