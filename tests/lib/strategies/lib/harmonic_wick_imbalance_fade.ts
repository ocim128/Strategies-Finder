import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingZScore } from "./price-action-statistics-core";

function normalizeHarmonicWickImbalanceFadeParams(params: StrategyParams): StrategyParams {
	const zscoreLookback = Math.max(2, Math.round(params.zscoreLookback ?? 55));
	const phiZScore = Math.max(0.1, Number(params.phiZScore ?? 1.618));
	return { ...params, zscoreLookback, phiZScore };
}

export const harmonic_wick_imbalance_fade: Strategy = {
	name: "Harmonic Wick Imbalance Fade",
	description:
		"Converts the raw wick imbalance into a rolling Z-score. Fades extremes that hit exactly 1.618 standard deviations, representing maximum asymmetric harmonic absorption.",
	defaultParams: { zscoreLookback: 55, phiZScore: 1.618 },
	paramLabels: { zscoreLookback: "Z-Score Lookback", phiZScore: "Phi Z-Score" },
	normalizeParams: normalizeHarmonicWickImbalanceFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeHarmonicWickImbalanceFadeParams(params);
		if (cleanData.length < np.zscoreLookback + 2) return [];
		const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
		const zScore = buildRollingZScore(wickImbalance, np.zscoreLookback);
		return createSignalLoop(cleanData, [zScore], (i) => {
			const z = zScore[i];
			if (z === null) return null;
			if (z < -np.phiZScore && cleanData[i].close > cleanData[i].open)
				return createBuySignal(cleanData, i, `Wick imbalance Z-score ${z.toFixed(2)} < -${np.phiZScore}`);
			if (z > np.phiZScore && cleanData[i].close < cleanData[i].open)
				return createSellSignal(cleanData, i, `Wick imbalance Z-score ${z.toFixed(2)} > ${np.phiZScore}`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["zscoreLookback", "phiZScore"] } };
