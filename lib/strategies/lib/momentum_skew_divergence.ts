import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingSkewness } from "./price-action-statistics-core";

function normalizeMomentumSkewDivergenceParams(params: StrategyParams): StrategyParams {
	const skewnessWindow = Math.max(3, Math.round(params.skewnessWindow ?? 30));
	const rocWindow = Math.max(1, Math.round(params.rocWindow ?? 10));
	return {
		...params,
		skewnessWindow,
		rocWindow: Math.min(rocWindow, skewnessWindow - 1) };
}

export const momentum_skew_divergence: Strategy = {
	name: "Momentum Skew Divergence",
	description: "When momentum direction contradicts return skewness, the trend is fragile. Positive ROC with negative skew means grinding uptrend with hidden sharp drops — counter-entry is favored.",
	defaultParams: {
		skewnessWindow: 30,
		rocWindow: 10 },
	paramLabels: {
		skewnessWindow: "Skewness Window",
		rocWindow: "ROC Window" },
	normalizeParams: normalizeMomentumSkewDivergenceParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeMomentumSkewDivergenceParams(params);
		if (cleanData.length < p.skewnessWindow) return [];

		const closes = getCloses(cleanData);
		const returns = buildRateOfChange(closes, 1);
		const returnValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			returnValues[i] = returns[i] ?? 0;
		}
		const skewness = buildRollingSkewness(returnValues, p.skewnessWindow);
		const roc = buildRateOfChange(closes, p.rocWindow);

		return createSignalLoop(cleanData, [skewness, roc], (i) => {
			if (i < p.skewnessWindow) return null;
			const skew = skewness[i];
			const rocVal = roc[i];
			if (skew === null || rocVal === null) return null;

			if (rocVal < 0 && skew > 0.3) {
				return createBuySignal(cleanData, i, `ROC ${rocVal.toFixed(4)} < 0 but skew ${skew.toFixed(3)} > 0.3, fragile downtrend reversal`);
			}
			if (rocVal > 0 && skew < -0.3) {
				return createSellSignal(cleanData, i, `ROC ${rocVal.toFixed(4)} > 0 but skew ${skew.toFixed(3)} < -0.3, fragile uptrend reversal`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["skewnessWindow", "rocWindow"] } };
