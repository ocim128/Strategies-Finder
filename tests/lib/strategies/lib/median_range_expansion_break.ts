import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingMedian, buildPercentileRank } from "./price-action-statistics-core";

function normalizeMedianRangeExpansionBreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		medianWindow: Math.max(2, Math.round(params.medianWindow ?? 20)),
		multiplier: Math.max(1.01, Number(params.multiplier ?? 1.5)) };
}

export const median_range_expansion_break: Strategy = {
	name: "Median Range Expansion Break",
	description: "When rolling median true range is at a low percentile rank (compressed volatility), a bar exceeding a multiple of that median signals a volatility regime break. Enter in the direction of the expanding bar's body.",
	defaultParams: {
		medianWindow: 20,
		multiplier: 1.5 },
	paramLabels: {
		medianWindow: "Median Window",
		multiplier: "Range Multiplier" },
	normalizeParams: normalizeMedianRangeExpansionBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeMedianRangeExpansionBreakParams(params);
		if (cleanData.length < p.medianWindow) return [];

		const trueRange = extractBarMetricSeries(cleanData, "trueRange");
		const medianTR = buildRollingMedian(trueRange, p.medianWindow);
		const medianValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			medianValues[i] = medianTR[i] ?? 0;
		}
		const rank = buildPercentileRank(medianValues, p.medianWindow);

		return createSignalLoop(cleanData, [medianTR, rank], (i) => {
			if (i < p.medianWindow) return null;
			const med = medianTR[i];
			const r = rank[i];
			if (med === null || r === null || med <= 0) return null;

			if (r > 0.15) return null;

			if (trueRange[i] > med * p.multiplier && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, `Median TR rank ${r.toFixed(3)} compressed, range ${trueRange[i].toFixed(4)} > ${p.multiplier}x median, bullish expansion`);
			}
			if (trueRange[i] > med * p.multiplier && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, `Median TR rank ${r.toFixed(3)} compressed, range ${trueRange[i].toFixed(4)} > ${p.multiplier}x median, bearish expansion`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["medianWindow", "multiplier"] } };
