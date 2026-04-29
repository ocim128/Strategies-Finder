import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";
import { calculateADX } from "../indicators";

function normalizeAdxGatedMedianAlignmentParams(params: StrategyParams): StrategyParams {
	const medianLookback = Math.max(2, Math.round(Number(params.median_lookback ?? 63)));
	const adxPeriod = Math.max(2, Math.round(Number(params.adx_period ?? 21)));
	const adxThreshold = Math.max(0, Number(params.adx_threshold ?? 25));
	return {
		...params,
		median_lookback: medianLookback,
		adx_period: adxPeriod,
		adx_threshold: adxThreshold };
}

export const adx_gated_median_alignment: Strategy = {
	name: "ADX Gated Median Alignment",
	description: "Activates median centerline alignment only during periods of strong trend persistence as measured by ADX, creating regime-gated daily directional signals.",
	defaultParams: {
		median_lookback: 63,
		adx_period: 21,
		adx_threshold: 25 },
	paramLabels: {
		median_lookback: "Median Lookback",
		adx_period: "ADX Period",
		adx_threshold: "ADX Threshold" },
	normalizeParams: normalizeAdxGatedMedianAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeAdxGatedMedianAlignmentParams(params);
		const medianLookback = p.median_lookback as number;
		const adxPeriod = p.adx_period as number;
		const adxThreshold = p.adx_threshold as number;
		const minBars = Math.max(medianLookback, adxPeriod * 2) + 1;
		if (cleanData.length < minBars) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const median = buildRollingMedian(closes, medianLookback);
		const adx = calculateADX(highs, lows, closes, adxPeriod);

		return createSignalLoop(cleanData, [median, adx], (i) => {
			const m = median[i];
			const a = adx[i];
			if (m === null || a === null) return null;

			if (a > adxThreshold && closes[i] > m) {
				return createBuySignal(cleanData, i, `ADX ${a.toFixed(1)} > ${adxThreshold}, close above median`);
			}
			if (a > adxThreshold && closes[i] < m) {
				return createSellSignal(cleanData, i, `ADX ${a.toFixed(1)} > ${adxThreshold}, close below median`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["median_lookback", "adx_period", "adx_threshold"] } };
