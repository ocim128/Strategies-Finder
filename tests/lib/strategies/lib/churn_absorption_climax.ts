import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeChurnAbsorptionClimaxParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		percentileWindow: Math.max(3, Math.round(params.percentileWindow ?? 50)) };
}

export const churn_absorption_climax: Strategy = {
	name: "Churn Absorption Climax",
	description: "Extremely high churn (volume per unit of range) at a percentile extreme means the market absorbs huge volume with minimal price change. The bar direction reveals who was absorbing.",
	defaultParams: {
		percentileWindow: 50 },
	paramLabels: {
		percentileWindow: "Percentile Window" },
	normalizeParams: normalizeChurnAbsorptionClimaxParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeChurnAbsorptionClimaxParams(params);
		if (cleanData.length < p.percentileWindow) return [];

		const volumes = getVolumes(cleanData);
		const ranges = buildRangeSeries(cleanData);
		const churn: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			churn[i] = ranges[i] > 0 ? volumes[i] / ranges[i] : 0;
		}
		const rank = buildPercentileRank(churn, p.percentileWindow);

		return createSignalLoop(cleanData, [rank], (i) => {
			if (i < p.percentileWindow) return null;
			const r = rank[i];
			if (r === null) return null;

			if (r > 0.9 && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, `Churn rank ${r.toFixed(3)} > 90th pctile, up-bar confirms buyer absorption`);
			}
			if (r > 0.9 && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, `Churn rank ${r.toFixed(3)} > 90th pctile, down-bar confirms seller absorption`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["percentileWindow"] } };
