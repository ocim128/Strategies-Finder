import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getWeightedClosePrices, getTypicalPrices } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeWeightedTypicalPhiDislocationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		atr_lookback: Math.max(2, Math.round(params.atr_lookback ?? 14)),
		phi_dislocation: Math.max(0.01, Math.abs(Number(params.phi_dislocation ?? 0.382))) };
}

export const weighted_typical_phi_dislocation: Strategy = {
	name: "Weighted Typical Phi Dislocation",
	description: "When the absolute difference between Weighted Close and Typical Price exceeds the golden ratio of True Range, intraday volume distribution has severely dislocated from the median price, creating a microstructure vacuum.",
	defaultParams: {
		atr_lookback: 14,
		phi_dislocation: 0.382 },
	paramLabels: {
		atr_lookback: "ATR Lookback",
		phi_dislocation: "Phi Dislocation" },
	normalizeParams: normalizeWeightedTypicalPhiDislocationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeWeightedTypicalPhiDislocationParams(params);
		if (cleanData.length < p.atr_lookback) return [];

		const weightedClose = getWeightedClosePrices(cleanData);
		const typicalPrice = getTypicalPrices(cleanData);
		const trueRange = extractBarMetricSeries(cleanData, "trueRange");
		const smoothedTR = buildRollingAverage(trueRange, p.atr_lookback);

		return createSignalLoop(cleanData, [smoothedTR], (i) => {
			const tr = smoothedTR[i];
			if (tr === null || tr <= 0) return null;

			const diff = weightedClose[i] - typicalPrice[i];
			const threshold = tr * p.phi_dislocation;
			const bullishBar = cleanData[i].close > cleanData[i].open;

			if (diff > threshold && bullishBar) {
				return createBuySignal(cleanData, i, `Weighted-Typical dislocation ${diff.toFixed(4)} > ${threshold.toFixed(4)}, late-bar sweep up`);
			}
			if (-diff > threshold && !bullishBar) {
				return createSellSignal(cleanData, i, `Typical-Weighted dislocation ${(-diff).toFixed(4)} > ${threshold.toFixed(4)}, late-bar sweep down`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["atr_lookback", "phi_dislocation"] } };





