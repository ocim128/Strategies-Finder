import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeInitiativePressureDivergenceFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 30)),
		zThreshold: Math.max(0.5, Math.abs(Number(params.zThreshold ?? 2.5))) };
}

export const initiative_pressure_divergence_fade: Strategy = {
	name: "Initiative Pressure Divergence Fade",
	description: "When initiative pressure reaches an extreme z-score but the bar's body direction opposes it, aggressive liquidity-takers are being absorbed. Fade the failed initiative direction.",
	defaultParams: {
		lookback: 30,
		zThreshold: 2.5 },
	paramLabels: {
		lookback: "Lookback",
		zThreshold: "Z-Score Threshold" },
	normalizeParams: normalizeInitiativePressureDivergenceFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativePressureDivergenceFadeParams(params);
		const lookback = p.lookback as number;
		const zThreshold = p.zThreshold as number;
		if (cleanData.length < lookback + 2) return [];

		const ipSeries = buildInitiativePressureSeries(cleanData, lookback);
		const ipClean = ipSeries.map(v => v ?? 0);
		const zScore = buildRollingZScore(ipClean, lookback);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < lookback) return null;
			const z = zScore[i];
			if (z === null) return null;

			const bullishBar = cleanData[i].close > cleanData[i].open;

			if (z < -zThreshold && bullishBar) {
				return createBuySignal(cleanData, i, `Extreme selling IP (z=${z.toFixed(2)}) but bar settled bullish — sellers absorbed`);
			}
			if (z > zThreshold && !bullishBar) {
				return createSellSignal(cleanData, i, `Extreme buying IP (z=${z.toFixed(2)}) but bar settled bearish — buyers absorbed`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "zThreshold"] } };
