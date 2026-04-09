import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildCumulativeDecaySum, buildPercentileRank } from "./price-action-statistics-core";

function normalizeCumulativeGapReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		decay: Math.max(0.01, Math.min(0.999, Number(params.decay ?? 0.95))),
		percentileWindow: Math.max(3, Math.round(params.percentileWindow ?? 50)) };
}

export const cumulative_gap_reversion: Strategy = {
	name: "Cumulative Gap Reversion",
	description: "Decay-weighted cumulative sum of gap percentages tracks systematic opening drift. At percentile-rank extremes, the market has systematically opened too far in one direction, favoring gap-fill reversion.",
	defaultParams: {
		decay: 0.95,
		percentileWindow: 50 },
	paramLabels: {
		decay: "Decay Factor",
		percentileWindow: "Percentile Window" },
	normalizeParams: normalizeCumulativeGapReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCumulativeGapReversionParams(params);
		if (cleanData.length < p.percentileWindow) return [];

		const gapPcts = extractBarMetricSeries(cleanData, "gapPct");
		const cumGap = buildCumulativeDecaySum(gapPcts, p.decay);
		const rank = buildPercentileRank(cumGap, p.percentileWindow);

		return createSignalLoop(cleanData, [rank], (i) => {
			if (i < p.percentileWindow) return null;
			const r = rank[i];
			if (r === null) return null;

			if (r < 0.05) {
				return createBuySignal(cleanData, i, `Cumulative gap rank ${r.toFixed(3)} < 5th pctile, oversold opening drift`);
			}
			if (r > 0.95) {
				return createSellSignal(cleanData, i, `Cumulative gap rank ${r.toFixed(3)} > 95th pctile, overbought opening drift`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["decay", "percentileWindow"] } };
