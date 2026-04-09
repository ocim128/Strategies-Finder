import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseLocationSeries, buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingSkewness } from "./price-action-statistics-core";

function normalizeInitiativePressureSkewReversalParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		skewLookback: Math.max(3, Math.round(params.skewLookback ?? 30)),
		minAbsSkew: Math.max(0, Math.abs(Number(params.minAbsSkew ?? 0.5))) };
}

export const initiative_pressure_skew_reversal: Strategy = {
	name: "Initiative Pressure Skew Reversal",
	description: "Rolling skewness of initiative pressure reveals asymmetry in aggressive dealer flow distribution. When skewness flips sign, the inventory distribution has structurally shifted. Enter in the new skew direction with close-location confirmation.",
	defaultParams: {
		skewLookback: 30,
		minAbsSkew: 0.5 },
	paramLabels: {
		skewLookback: "Skewness Lookback",
		minAbsSkew: "Min |Skewness|" },
	normalizeParams: normalizeInitiativePressureSkewReversalParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativePressureSkewReversalParams(params);
		const skewLookback = p.skewLookback as number;
		const minAbsSkew = p.minAbsSkew as number;
		if (cleanData.length < skewLookback + 2) return [];

		const ipSeries = buildInitiativePressureSeries(cleanData, skewLookback);
		const ipClean = ipSeries.map(v => v ?? 0);
		const skew = buildRollingSkewness(ipClean, skewLookback);
		const closeLoc = buildCloseLocationSeries(cleanData);

		return createSignalLoop(cleanData, [skew], (i) => {
			if (i < skewLookback + 1) return null;
			const priorSkew = skew[i - 1];
			const currSkew = skew[i];
			if (priorSkew === null || currSkew === null) return null;

			if (priorSkew < -minAbsSkew && currSkew > minAbsSkew && closeLoc[i] > 0.5) {
				return createBuySignal(cleanData, i, `IP skew flipped from bearish (${priorSkew.toFixed(2)}) to bullish (${currSkew.toFixed(2)}), close location confirms`);
			}
			if (priorSkew > minAbsSkew && currSkew < -minAbsSkew && closeLoc[i] < 0.5) {
				return createSellSignal(cleanData, i, `IP skew flipped from bullish (${priorSkew.toFixed(2)}) to bearish (${currSkew.toFixed(2)}), close location confirms`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["skewLookback", "minAbsSkew"] } };
