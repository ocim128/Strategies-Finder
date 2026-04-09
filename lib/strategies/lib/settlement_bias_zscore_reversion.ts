import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getWeightedClosePrices, getTypicalPrices } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeSettlementBiasZscoreReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 30)),
		zThreshold: Math.max(0.5, Math.abs(Number(params.zThreshold ?? 2.5))) };
}

export const settlement_bias_zscore_reversion: Strategy = {
	name: "Settlement Bias Z-Score Reversion",
	description: "The divergence between weighted close and typical price isolates how much the settlement pulls valuation away from the bar's auction center. When this bias reaches a z-score extreme, the settlement mechanism is stretched beyond its norm and likely to revert.",
	defaultParams: {
		lookback: 30,
		zThreshold: 2.5 },
	paramLabels: {
		lookback: "Lookback",
		zThreshold: "Z-Score Threshold" },
	normalizeParams: normalizeSettlementBiasZscoreReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSettlementBiasZscoreReversionParams(params);
		const lookback = p.lookback as number;
		const zThreshold = p.zThreshold as number;
		if (cleanData.length < lookback + 2) return [];

		const weightedClose = getWeightedClosePrices(cleanData);
		const typicalPrice = getTypicalPrices(cleanData);
		const bias = weightedClose.map((wc, i) => wc - typicalPrice[i]);
		const zScore = buildRollingZScore(bias, lookback);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < lookback) return null;
			const z = zScore[i];
			if (z === null) return null;

			if (z < -zThreshold) {
				return createBuySignal(cleanData, i, `Settlement bias z-score extreme bearish (${z.toFixed(2)}) — revert long`);
			}
			if (z > zThreshold) {
				return createSellSignal(cleanData, i, `Settlement bias z-score extreme bullish (${z.toFixed(2)}) — revert short`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "zThreshold"] } };
