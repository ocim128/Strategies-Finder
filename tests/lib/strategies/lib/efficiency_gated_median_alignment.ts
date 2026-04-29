import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingMedian } from "./price-action-statistics-core";

function normalizeEfficiencyGatedMedianAlignmentParams(params: StrategyParams): StrategyParams {
	const lookback = Math.max(2, Math.round(Number(params.lookback ?? 63)));
	const efficiencyThreshold = Math.max(0, Math.min(1, Number(params.efficiency_threshold ?? 0.45)));
	return {
		...params,
		lookback,
		efficiency_threshold: efficiencyThreshold };
}

export const efficiency_gated_median_alignment: Strategy = {
	name: "Efficiency Gated Median Alignment",
	description: "Only permits median alignment signals when the efficiency ratio indicates sufficient directional persistence, otherwise staying flat.",
	defaultParams: {
		lookback: 63,
		efficiency_threshold: 0.45 },
	paramLabels: {
		lookback: "Lookback",
		efficiency_threshold: "Efficiency Threshold" },
	normalizeParams: normalizeEfficiencyGatedMedianAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEfficiencyGatedMedianAlignmentParams(params);
		const lookback = p.lookback as number;
		const effThreshold = p.efficiency_threshold as number;
		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const median = buildRollingMedian(closes, lookback);
		const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);

		return createSignalLoop(cleanData, [median, efficiencyRatio], (i) => {
			const m = median[i];
			const er = efficiencyRatio[i];
			if (m === null || er === null) return null;

			if (er > effThreshold && closes[i] > m) {
				return createBuySignal(cleanData, i, `ER ${er.toFixed(2)} > ${effThreshold}, close above median`);
			}
			if (er > effThreshold && closes[i] < m) {
				return createSellSignal(cleanData, i, `ER ${er.toFixed(2)} > ${effThreshold}, close below median`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "efficiency_threshold"] } };
