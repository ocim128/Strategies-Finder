import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries, buildDualTimeframeRatio, buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

function normalizeVolTermStructureRatioBreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fastWindow: Math.max(2, Math.round(params.fastWindow ?? 5)),
		slowWindow: Math.max(2, Math.round(params.slowWindow ?? 50)) };
}

export const vol_term_structure_ratio_break: Strategy = {
	name: "Vol Term Structure Ratio Break",
	description: "Fast/slow true range ratio proxies the vol term structure. When the ratio collapses to a low percentile, near-term vol has dropped far below the trailing average — the vol surface is inverted. Enter in the direction of close deviation from its rolling median as dealer hedges lighten.",
	defaultParams: {
		fastWindow: 5,
		slowWindow: 50 },
	paramLabels: {
		fastWindow: "Fast Window",
		slowWindow: "Slow Window" },
	normalizeParams: normalizeVolTermStructureRatioBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolTermStructureRatioBreakParams(params);
		const fastWindow = p.fastWindow as number;
		const slowWindow = p.slowWindow as number;
		if (cleanData.length < slowWindow + 2) return [];

		const closes = getCloses(cleanData);
		const trSeries = extractBarMetricSeries(cleanData, "trueRange");
		const rangeRatio = buildDualTimeframeRatio(trSeries, fastWindow, slowWindow, buildRollingAverage);
		const ratioClean = rangeRatio.map(v => v ?? 0);
		const ratioRank = buildPercentileRank(ratioClean, slowWindow);
		const priceMedian = buildRollingMedian(closes, slowWindow);

		return createSignalLoop(cleanData, [ratioRank, priceMedian], (i) => {
			if (i < slowWindow) return null;
			const rank = ratioRank[i];
			const median = priceMedian[i];
			if (rank === null || median === null) return null;
			if (rank >= 0.15) return null;

			if (closes[i] > median) {
				return createBuySignal(cleanData, i, `Vol term structure inverted (rank ${(rank * 100).toFixed(0)}%), close above median`);
			}
			if (closes[i] < median) {
				return createSellSignal(cleanData, i, `Vol term structure inverted (rank ${(rank * 100).toFixed(0)}%), close below median`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fastWindow", "slowWindow"] } };
