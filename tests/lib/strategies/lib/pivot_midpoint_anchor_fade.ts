import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, buildPivotFlags } from "../strategy-helpers";

function normalizePivotMidpointAnchorFadeParams(params: StrategyParams): StrategyParams {
	const pivotLeftBars = Math.max(1, Math.round(params.pivotLeftBars ?? 5));
	return {
		...params,
		pivotLeftBars,
		deviationMultiplier: Math.max(0.01, Number(params.deviationMultiplier ?? 0.7)) };
}

export const pivot_midpoint_anchor_fade: Strategy = {
	name: "Pivot Midpoint Anchor Fade",
	description: "The midpoint between the most recent pivot high and low anchors structural fair value. When price deviates significantly from this anchor, reversion is favored.",
	defaultParams: {
		pivotLeftBars: 5,
		deviationMultiplier: 0.7 },
	paramLabels: {
		pivotLeftBars: "Pivot Bars",
		deviationMultiplier: "Deviation Multiplier" },
	normalizeParams: normalizePivotMidpointAnchorFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizePivotMidpointAnchorFadeParams(params);
		const swingLen = p.pivotLeftBars;
		if (cleanData.length < swingLen * 2 + 2) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);
		const { pivotHighs, pivotLows } = buildPivotFlags(highs, lows, swingLen);

		return createSignalLoop(cleanData, [], (i) => {
			let lastPivHigh = -1;
			let lastPivLow = -1;
			for (let j = i - swingLen; j >= 0; j--) {
				if (lastPivHigh < 0 && pivotHighs[j]) lastPivHigh = j;
				if (lastPivLow < 0 && pivotLows[j]) lastPivLow = j;
				if (lastPivHigh >= 0 && lastPivLow >= 0) break;
			}
			if (lastPivHigh < 0 || lastPivLow < 0) return null;

			const pivHigh = highs[lastPivHigh];
			const pivLow = lows[lastPivLow];
			const mid = (pivHigh + pivLow) / 2;
			const range = pivHigh - pivLow;
			if (range <= 0) return null;

			const threshold = range * p.deviationMultiplier;

			if (closes[i] < mid - threshold) {
				return createBuySignal(cleanData, i, `Close ${closes[i].toFixed(2)} < midpoint ${mid.toFixed(2)} - ${(threshold).toFixed(2)}, structural fade`);
			}
			if (closes[i] > mid + threshold) {
				return createSellSignal(cleanData, i, `Close ${closes[i].toFixed(2)} > midpoint ${mid.toFixed(2)} + ${(threshold).toFixed(2)}, structural fade`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pivotLeftBars", "deviationMultiplier"] } };
