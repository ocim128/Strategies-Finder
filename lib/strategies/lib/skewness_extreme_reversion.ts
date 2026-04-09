import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingStdDev, buildRollingSkewness } from "./price-action-statistics-core";

function normalizeSkewnessExtremeReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		skewLookback: Math.max(3, Math.round(params.skewLookback ?? 30)),
		skewThreshold: Math.max(0, Math.abs(Number(params.skewThreshold ?? 1.5))) };
}

export const skewness_extreme_reversion: Strategy = {
	name: "Skewness Extreme Reversion",
	description: "Rolling skewness of close returns measures return distribution asymmetry. Extreme skewness with price extended in the skew direction signals a stretched distribution likely to correct. Fade the overshoot.",
	defaultParams: {
		skewLookback: 30,
		skewThreshold: 1.5 },
	paramLabels: {
		skewLookback: "Skewness Lookback",
		skewThreshold: "Skewness Threshold" },
	normalizeParams: normalizeSkewnessExtremeReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSkewnessExtremeReversionParams(params);
		const lookback = p.skewLookback as number;
		const threshold = p.skewThreshold as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const returns: number[] = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			returns[i] = closes[i] - closes[i - 1];
		}

		const skew = buildRollingSkewness(returns, lookback);
		const avgClose = buildRollingAverage(closes, lookback);
		const stdClose = buildRollingStdDev(closes, lookback);

		return createSignalLoop(cleanData, [skew, avgClose, stdClose], (i) => {
			if (i < lookback) return null;
			const s = skew[i];
			const avg = avgClose[i];
			const sd = stdClose[i];
			if (s === null || avg === null || sd === null || sd <= 0) return null;

			const zScore = (closes[i] - avg) / sd;

			if (s < -threshold && zScore < -1) {
				return createBuySignal(cleanData, i, `Extreme negative skew (${s.toFixed(2)}) with price ${zScore.toFixed(1)}σ below mean`);
			}
			if (s > threshold && zScore > 1) {
				return createSellSignal(cleanData, i, `Extreme positive skew (${s.toFixed(2)}) with price ${zScore.toFixed(1)}σ above mean`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["skewLookback", "skewThreshold"] } };
