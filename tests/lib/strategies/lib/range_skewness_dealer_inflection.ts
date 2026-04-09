import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingSkewness } from "./price-action-statistics-core";

function normalizeRangeSkewnessDealerInflectionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		skewLookback: Math.max(3, Math.round(params.skewLookback ?? 30)),
		minAbsSkew: Math.max(0, Math.abs(Number(params.minAbsSkew ?? 0.5))) };
}

export const range_skewness_dealer_inflection: Strategy = {
	name: "Range Skewness Dealer Inflection",
	description: "Rolling skewness of the true range series captures directional volatility asymmetry from dealer gamma exposure. When range skewness flips sign, the directional volatility asymmetry has reversed — dealer gamma has rebalanced. Enter in the new skewness direction with body confirmation.",
	defaultParams: {
		skewLookback: 30,
		minAbsSkew: 0.5 },
	paramLabels: {
		skewLookback: "Skewness Lookback",
		minAbsSkew: "Min |Skewness|" },
	normalizeParams: normalizeRangeSkewnessDealerInflectionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRangeSkewnessDealerInflectionParams(params);
		const skewLookback = p.skewLookback as number;
		const minAbsSkew = p.minAbsSkew as number;
		if (cleanData.length < skewLookback + 2) return [];

		const trSeries = extractBarMetricSeries(cleanData, "trueRange");
		const trSkew = buildRollingSkewness(trSeries, skewLookback);
		const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");

		return createSignalLoop(cleanData, [trSkew], (i) => {
			if (i < skewLookback + 1) return null;
			const priorSkew = trSkew[i - 1];
			const currSkew = trSkew[i];
			if (priorSkew === null || currSkew === null) return null;

			if (priorSkew < -minAbsSkew && currSkew >= 0 && bodyDir[i] > 0) {
				return createBuySignal(cleanData, i, `Range skewness flipped from bearish (${priorSkew.toFixed(2)}) to neutral/bullish, body confirms`);
			}
			if (priorSkew > minAbsSkew && currSkew <= 0 && bodyDir[i] < 0) {
				return createSellSignal(cleanData, i, `Range skewness flipped from bullish (${priorSkew.toFixed(2)}) to neutral/bearish, body confirms`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["skewLookback", "minAbsSkew"] } };
