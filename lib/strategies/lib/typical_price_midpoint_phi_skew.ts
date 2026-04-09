import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-statistics-core";
import { buildRollingAverage } from "./price-action-frequency-core";

function normalizeTypicalPriceMidpointPhiSkewParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		atr_lookback: Math.max(2, Math.round(params.atr_lookback ?? 14)),
		phi_skew_limit: Math.max(0.01, Math.abs(Number(params.phi_skew_limit ?? 0.382))) };
}

export const typical_price_midpoint_phi_skew: Strategy = {
	name: "Typical Price Midpoint Phi Skew",
	description: "When the distance between the Typical Price and Body Midpoint exceeds the golden ratio of True Range, extreme intra-bar structural tension has built up, creating a price vacuum.",
	defaultParams: {
		atr_lookback: 14,
		phi_skew_limit: 0.382 },
	paramLabels: {
		atr_lookback: "ATR Lookback",
		phi_skew_limit: "Phi Skew Limit" },
	normalizeParams: normalizeTypicalPriceMidpointPhiSkewParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeTypicalPriceMidpointPhiSkewParams(params);
		if (cleanData.length < p.atr_lookback) return [];

		const typical = getTypicalPrices(cleanData);
		const bodyMid = extractBarMetricSeries(cleanData, "bodyMid");
		const trueRange = extractBarMetricSeries(cleanData, "trueRange");
		const smoothedTR = buildRollingAverage(trueRange, p.atr_lookback);

		return createSignalLoop(cleanData, [smoothedTR], (i) => {
			const tr = smoothedTR[i];
			if (tr === null || tr <= 0) return null;

			const diff = typical[i] - bodyMid[i];
			const threshold = tr * p.phi_skew_limit;
			const bullishBar = cleanData[i].close > cleanData[i].open;

			if (diff > threshold && bullishBar) {
				return createBuySignal(cleanData, i, `Typical-midpoint skew ${diff.toFixed(4)} > phi * ATR, bullish tension`);
			}
			if (-diff > threshold && !bullishBar) {
				return createSellSignal(cleanData, i, `Midpoint-typical skew ${(-diff).toFixed(4)} > phi * ATR, bearish tension`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["atr_lookback", "phi_skew_limit"] } };
