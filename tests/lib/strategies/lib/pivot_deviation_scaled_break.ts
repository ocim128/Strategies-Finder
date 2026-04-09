import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, detectPivotsWithDeviation } from "../strategy-helpers";

function normalizePivotDeviationScaledBreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pivotLookback: Math.max(2, Math.round(params.pivotLookback ?? 10)),
		deviationScale: Math.max(0.1, Math.abs(Number(params.deviationScale ?? 1.5))) };
}

export const pivot_deviation_scaled_break: Strategy = {
	name: "Pivot Deviation Scaled Break",
	description: "Pivot levels come with a natural deviation. When price extends beyond a pivot by more than its own deviation scaled by a multiplier, the market has broken its natural range — a structural break rather than routine fluctuation.",
	defaultParams: {
		pivotLookback: 10,
		deviationScale: 1.5 },
	paramLabels: {
		pivotLookback: "Pivot Lookback",
		deviationScale: "Deviation Scale" },
	normalizeParams: normalizePivotDeviationScaledBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizePivotDeviationScaledBreakParams(params);
		const lookback = p.pivotLookback as number;
		const scale = p.deviationScale as number;
		if (cleanData.length < lookback * 2 + 2) return [];

		const closes = getCloses(cleanData);
		const pivots = detectPivotsWithDeviation(cleanData, 1.0, lookback);

		let lastPivotHigh: { price: number; index: number } | null = null;
		let lastPivotLow: { price: number; index: number } | null = null;

		const prevHighPrices: number[] = [];
		const prevLowPrices: number[] = [];

		for (const pv of pivots) {
			if (pv.isHigh) {
				if (lastPivotHigh) prevHighPrices.push(lastPivotHigh.price);
				lastPivotHigh = { price: pv.price, index: pv.index };
			} else {
				if (lastPivotLow) prevLowPrices.push(lastPivotLow.price);
				lastPivotLow = { price: pv.price, index: pv.index };
			}
		}

		if (!lastPivotHigh || !lastPivotLow) return [];

		const computeDeviation = (prices: number[]): number => {
			if (prices.length < 2) return Math.max(0.001, (lastPivotHigh!.price - lastPivotLow!.price) * 0.01);
			const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
			const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
			return Math.max(0.001, Math.sqrt(variance));
		};

		const highDev = computeDeviation(prevHighPrices);
		const lowDev = computeDeviation(prevLowPrices);

		return createSignalLoop(cleanData, [], (i) => {
			if (closes[i] > lastPivotHigh!.price + highDev * scale) {
				return createBuySignal(cleanData, i, `Close broke above pivot high ${lastPivotHigh!.price.toFixed(2)} + ${scale}σ deviation (${highDev.toFixed(4)})`);
			}
			if (closes[i] < lastPivotLow!.price - lowDev * scale) {
				return createSellSignal(cleanData, i, `Close broke below pivot low ${lastPivotLow!.price.toFixed(2)} - ${scale}σ deviation (${lowDev.toFixed(4)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pivotLookback", "deviationScale"] } };
