import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation, buildRollingMedian } from "./price-action-statistics-core";

function normalizeRangeClusteringMomentumParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		autocorrWindow: Math.max(3, Math.round(params.autocorrWindow ?? 30)),
		rangeMedianWindow: Math.max(2, Math.round(params.rangeMedianWindow ?? 20)) };
}

export const range_clustering_momentum: Strategy = {
	name: "Range Clustering Momentum",
	description: "When range autocorrelation is high (volatility clustering active), a bar with range above the rolling median indicates a volatility impulse whose body direction predicts continuation.",
	defaultParams: {
		autocorrWindow: 30,
		rangeMedianWindow: 20 },
	paramLabels: {
		autocorrWindow: "Autocorrelation Window",
		rangeMedianWindow: "Range Median Window" },
	normalizeParams: normalizeRangeClusteringMomentumParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRangeClusteringMomentumParams(params);
		if (cleanData.length < Math.max(p.autocorrWindow, p.rangeMedianWindow)) return [];

		const ranges = buildRangeSeries(cleanData);
		const autocorr = buildRollingAutoCorrelation(ranges, p.autocorrWindow);
		const rangeMedian = buildRollingMedian(ranges, p.rangeMedianWindow);

		return createSignalLoop(cleanData, [autocorr, rangeMedian], (i) => {
			if (i < Math.max(p.autocorrWindow, p.rangeMedianWindow)) return null;
			const ac = autocorr[i];
			const med = rangeMedian[i];
			if (ac === null || med === null) return null;

			if (ac < 0.3 || ranges[i] <= med) return null;

			if (cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, `Range clustering AC ${ac.toFixed(3)} > 0.3, range ${ranges[i].toFixed(4)} > median ${med.toFixed(4)}, bullish impulse`);
			}
			if (cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, `Range clustering AC ${ac.toFixed(3)} > 0.3, range ${ranges[i].toFixed(4)} > median ${med.toFixed(4)}, bearish impulse`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["autocorrWindow", "rangeMedianWindow"] } };





