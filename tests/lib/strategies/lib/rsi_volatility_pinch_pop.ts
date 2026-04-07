import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateRSI } from "../indicators";
import { buildRollingMinMax } from "./price-action-statistics-core";

export const rsi_volatility_pinch_pop: Strategy = {
	name: "RSI Volatility Pinch Pop",
	description: "Quantifies the exact moment momentum transitions from compressed to explosive by finding rolling dead-zones in the absolute Rate-of-Change of the RSI, triggering only when that momentum-volatility explodes.",
	defaultParams: {
		rsiPeriod: 14,
		pinchLookback: 30,
		rocTarget: 10.0 },
	paramLabels: {
		rsiPeriod: "RSI Base Period",
		pinchLookback: "RSI-ROC Rolling Minimum Window",
		rocTarget: "Absolute RSI Velocity Trigger" },
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const rPeriod = params.rsiPeriod as number;
		const pLookback = params.pinchLookback as number;

		if (cleanData.length < Math.max(rPeriod, pLookback) + 10) return [];

		const rsi = calculateRSI(cleanData.map(d => d.close), rPeriod);

		// RSI bar-over-bar change (Rate of Change in RSI points)
		const rsiRoc: number[] = cleanData.map((_, i) => {
			if (i === 0 || rsi[i] === null || rsi[i - 1] === null) return 0;
			return rsi[i]! - rsi[i - 1]!;
		});

		// Absolute RSI ROC to measure oscillator volatility magnitude
		const absRsiRoc = rsiRoc.map(v => Math.abs(v));

		// Rolling minimum of absolute RSI ROC locates pinch zones
		const limits = buildRollingMinMax(absRsiRoc, pLookback);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < Math.max(rPeriod, pLookback) + 2 || rsi[i] === null || limits.min[i - 1] === null) return null;

			const recentMin = limits.min[i - 1]!;
			const target = params.rocTarget as number;

			// Recently pinched: the prior bar's rolling minimum was very low (< 2 RSI points)
			const wasPinched = recentMin < 2.0;

			// Current raw RSI ROC exceeds velocity threshold
			const currRoc = rsiRoc[i];

			if (wasPinched && currRoc > target && rsi[i]! > 50) {
				return createBuySignal(cleanData, i, "RSI momentum explosion from deep oscillator volatility compression");
			}
			if (wasPinched && currRoc < -target && rsi[i]! < 50) {
				return createSellSignal(cleanData, i, "RSI momentum collapse from deep oscillator volatility compression");
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["rsiPeriod", "pinchLookback", "rocTarget"] } };
