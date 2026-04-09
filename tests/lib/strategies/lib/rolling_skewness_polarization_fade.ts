import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingSkewness } from "./price-action-statistics-core";

function normalizeRollingSkewnessPolarizationFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 30)),
		skew_thresh: Math.max(0.1, Math.abs(Number(params.skew_thresh ?? 1.5))) };
}

export const rolling_skewness_polarization_fade: Strategy = {
	name: "Rolling Skewness Polarization Fade",
	description: "Extreme rolling skewness in returns implies panic or euphoria pricing into the tails. A counter-close signals the emotional extreme is trapped and mean reversion is favored.",
	defaultParams: {
		lookback: 30,
		skew_thresh: 1.5 },
	paramLabels: {
		lookback: "Lookback",
		skew_thresh: "Skewness Threshold" },
	normalizeParams: normalizeRollingSkewnessPolarizationFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRollingSkewnessPolarizationFadeParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const returns = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			returns[i] = closes[i - 1] !== 0 ? (closes[i] - closes[i - 1]) / closes[i - 1] : 0;
		}
		const skewness = buildRollingSkewness(returns, p.lookback);

		return createSignalLoop(cleanData, [skewness], (i) => {
			if (i < p.lookback) return null;
			const skew = skewness[i];
			if (skew === null) return null;

			if (skew < -p.skew_thresh && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, `Return skew ${skew.toFixed(3)} < -${p.skew_thresh}, downside panic exhausted`);
			}
			if (skew > p.skew_thresh && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, `Return skew ${skew.toFixed(3)} > ${p.skew_thresh}, upside euphoria exhausted`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "skew_thresh"] } };
