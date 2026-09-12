import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingSkewness, buildRollingZScore, buildRateOfChange } from "./price-action-statistics-core";

function normalizeTrueRangeSkewnessInitiationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		skew_window: Math.max(3, Math.round(params.skew_window ?? 20)),
		zscore_trigger: Math.max(0.5, Number(params.zscore_trigger ?? 2.0)),
	};
}

export const true_range_skewness_initiation: Strategy = {
	name: "True Range Skewness Initiation",
	description: "A sudden spike in the skewness of True Range indicates unilateral directional panic or euphoria initiating a new auction. Volatility asymmetry signals a structural break.",
	defaultParams: {
		skew_window: 20,
		zscore_trigger: 2.0,
	},
	paramLabels: {
		skew_window: "Skewness Window",
		zscore_trigger: "Z-Score Trigger",
	},
	normalizeParams: normalizeTrueRangeSkewnessInitiationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeTrueRangeSkewnessInitiationParams(params);
		if (cleanData.length < p.skew_window * 2) return [];

		const trueRange = extractBarMetricSeries(cleanData, 'trueRange');
		const skewness = buildRollingSkewness(trueRange, p.skew_window);
		const skewClean = skewness.map(v => v ?? 0);
		const skewZ = buildRollingZScore(skewClean, p.skew_window);

		const closes = getCloses(cleanData);
		const priceRoc = buildRateOfChange(closes, 1);

		return createSignalLoop(cleanData, [skewZ, priceRoc], (i) => {
			if (i < p.skew_window) return null;
			const z = skewZ[i];
			const pr = priceRoc[i];
			if (z === null || pr === null) return null;

			if (Math.abs(z) > p.zscore_trigger) {
				if (pr > 0) {
					return createBuySignal(cleanData, i, `TR skewness initiation Z=${z.toFixed(2)}, price ROC positive`);
				}
				if (pr < 0) {
					return createSellSignal(cleanData, i, `TR skewness initiation Z=${z.toFixed(2)}, price ROC negative`);
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["skew_window", "zscore_trigger"],
	},
};





