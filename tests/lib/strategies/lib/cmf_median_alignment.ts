import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";
import { calculateCMF } from "../indicators";

function normalizeCmfMedianAlignmentParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))) };
}

export const cmf_median_alignment: Strategy = {
	name: "CMF Median Alignment",
	description: "Combines Chaikin Money Flow participation state with the rolling median centerline to generate alignment signals only when volume supports the price reference.",
	defaultParams: {
		lookback: 63 },
	paramLabels: {
		lookback: "Lookback" },
	normalizeParams: normalizeCmfMedianAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCmfMedianAlignmentParams(params);
		const lookback = p.lookback as number;
		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const volumes = getVolumes(cleanData);
		const median = buildRollingMedian(closes, lookback);
		const cmf = calculateCMF(highs, lows, closes, volumes, lookback);

		return createSignalLoop(cleanData, [median, cmf], (i) => {
			const m = median[i];
			const c = cmf[i];
			if (m === null || c === null) return null;

			if (c > 0 && closes[i] > m) {
				return createBuySignal(cleanData, i, `CMF ${c.toFixed(3)} positive, close above median`);
			}
			if (c < 0 && closes[i] < m) {
				return createSellSignal(cleanData, i, `CMF ${c.toFixed(3)} negative, close below median`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"] } };
