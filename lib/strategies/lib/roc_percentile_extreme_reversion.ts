import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";

function normalizeRocPercentileExtremeReversionParams(params: StrategyParams): StrategyParams {
	const rocWindow = Math.max(1, Math.round(params.rocWindow ?? 10));
	const percentileWindow = Math.max(rocWindow + 1, Math.round(params.percentileWindow ?? 60));
	return {
		...params,
		rocWindow,
		percentileWindow };
}

export const roc_percentile_extreme_reversion: Strategy = {
	name: "ROC Percentile Extreme Reversion",
	description: "When rate of change reaches a historically extreme percentile rank, the move is statistically unusual. Such extremes tend to revert as impetus exhausts, with the percentile rank adapting the threshold to current volatility.",
	defaultParams: {
		rocWindow: 10,
		percentileWindow: 60 },
	paramLabels: {
		rocWindow: "ROC Window",
		percentileWindow: "Percentile Window" },
	normalizeParams: normalizeRocPercentileExtremeReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRocPercentileExtremeReversionParams(params);
		if (cleanData.length < p.percentileWindow) return [];

		const closes = getCloses(cleanData);
		const roc = buildRateOfChange(closes, p.rocWindow);
		const rocValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			rocValues[i] = roc[i] ?? 0;
		}
		const rank = buildPercentileRank(rocValues, p.percentileWindow);

		return createSignalLoop(cleanData, [rank], (i) => {
			if (i < p.percentileWindow) return null;
			const r = rank[i];
			if (r === null) return null;

			if (r < 0.05) {
				return createBuySignal(cleanData, i, `ROC rank ${r.toFixed(3)} < 5th pctile, unusually negative ROC, reversion`);
			}
			if (r > 0.95) {
				return createSellSignal(cleanData, i, `ROC rank ${r.toFixed(3)} > 95th pctile, unusually positive ROC, reversion`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["rocWindow", "percentileWindow"] } };
