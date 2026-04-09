import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildCumulativeDecaySum, buildPercentileRank } from "./price-action-statistics-core";

function normalizeWickImbalanceDecayEntryParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		decay: Math.max(0.01, Math.min(0.999, Number(params.decay ?? 0.92))),
		percentileWindow: Math.max(3, Math.round(params.percentileWindow ?? 50)) };
}

export const wick_imbalance_decay_entry: Strategy = {
	name: "Wick Imbalance Decay Entry",
	description: "Cumulative decay of wick imbalance tracks sustained one-sided rejection. At percentile extremes, the consistently rejecting side has demonstrated absorption strength and continuation is favored.",
	defaultParams: {
		decay: 0.92,
		percentileWindow: 50 },
	paramLabels: {
		decay: "Decay Factor",
		percentileWindow: "Percentile Window" },
	normalizeParams: normalizeWickImbalanceDecayEntryParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeWickImbalanceDecayEntryParams(params);
		if (cleanData.length < p.percentileWindow) return [];

		const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
		const decayed = buildCumulativeDecaySum(wickImbalance, p.decay);
		const rank = buildPercentileRank(decayed, p.percentileWindow);

		return createSignalLoop(cleanData, [rank], (i) => {
			if (i < p.percentileWindow) return null;
			const r = rank[i];
			if (r === null) return null;

			if (r < 0.05) {
				return createBuySignal(cleanData, i, `Decayed wick imbalance rank ${r.toFixed(3)} < 5th pctile, sustained lower-wick absorption`);
			}
			if (r > 0.95) {
				return createSellSignal(cleanData, i, `Decayed wick imbalance rank ${r.toFixed(3)} > 95th pctile, sustained upper-wick absorption`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["decay", "percentileWindow"] } };
