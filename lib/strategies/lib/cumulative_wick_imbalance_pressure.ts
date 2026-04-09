import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-statistics-core";
import { buildRollingAverage } from "./price-action-frequency-core";

function normalizeCumulativeWickImbalancePressureParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 14)),
		imbalance_thresh: Math.max(0.01, Math.abs(Number(params.imbalance_thresh ?? 0.4))) };
}

export const cumulative_wick_imbalance_pressure: Strategy = {
	name: "Cumulative Wick Imbalance Pressure",
	description: "A smoothed rolling average of wick imbalance reveals hidden cumulative limit-order pressure persistently rejecting one side of the market.",
	defaultParams: {
		lookback: 14,
		imbalance_thresh: 0.4 },
	paramLabels: {
		lookback: "Lookback",
		imbalance_thresh: "Imbalance Threshold" },
	normalizeParams: normalizeCumulativeWickImbalancePressureParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCumulativeWickImbalancePressureParams(params);
		if (cleanData.length < p.lookback) return [];

		const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
		const smoothed = buildRollingAverage(wickImbalance, p.lookback);

		return createSignalLoop(cleanData, [smoothed], (i) => {
			if (i < p.lookback) return null;
			const avg = smoothed[i];
			if (avg === null) return null;

			if (avg > p.imbalance_thresh) {
				return createBuySignal(cleanData, i, `Smoothed wick imbalance ${avg.toFixed(3)} > ${p.imbalance_thresh}, cumulative lower-wick rejection`);
			}
			if (avg < -p.imbalance_thresh) {
				return createSellSignal(cleanData, i, `Smoothed wick imbalance ${avg.toFixed(3)} < -${p.imbalance_thresh}, cumulative upper-wick rejection`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "imbalance_thresh"] } };
