import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingSkewness, buildRollingZScore } from "./price-action-statistics-core";

function normalizeReturnSkewnessExhaustionFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		skew_window: Math.max(3, Math.round(params.skew_window ?? 30)),
		zscore_threshold: Math.max(0.5, Number(params.zscore_threshold ?? 2.5)),
	};
}

export const return_skewness_exhaustion_fade: Strategy = {
	name: "Return Skewness Exhaustion Fade",
	description: "A highly skewed distribution of returns indicates unilateral panic. Fading the extreme z-score of this skewness targets the exact moment the one-sided panic runs out of participants.",
	defaultParams: {
		skew_window: 30,
		zscore_threshold: 2.5,
	},
	paramLabels: {
		skew_window: "Skewness Window",
		zscore_threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeReturnSkewnessExhaustionFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeReturnSkewnessExhaustionFadeParams(params);
		if (cleanData.length < p.skew_window * 2) return [];

		const returns = extractBarMetricSeries(cleanData, 'closeReturn');
		const skewness = buildRollingSkewness(returns, p.skew_window);
		const skewClean = skewness.map(v => v ?? 0);
		const skewZ = buildRollingZScore(skewClean, p.skew_window);

		return createSignalLoop(cleanData, [skewZ], (i) => {
			if (i < p.skew_window) return null;
			const z = skewZ[i];
			if (z === null) return null;

			if (z < -p.zscore_threshold) {
				return createBuySignal(cleanData, i, `Return skewness exhaustion Z=${z.toFixed(2)}, downside tail climaxed`);
			}
			if (z > p.zscore_threshold) {
				return createSellSignal(cleanData, i, `Return skewness exhaustion Z=${z.toFixed(2)}, upside tail climaxed`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["skew_window", "zscore_threshold"],
	},
};
