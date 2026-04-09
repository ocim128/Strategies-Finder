import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeInitiativePressureRankExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pressureLookback: Math.max(2, Math.round(params.pressureLookback ?? 20)),
		exhaustionRank: Math.max(50, Math.min(99, Number(params.exhaustionRank ?? 90))) };
}

export const initiative_pressure_rank_exhaustion: Strategy = {
	name: "Initiative Pressure Rank Exhaustion",
	description: "When aggressive initiative pressure reaches an extreme percentile rank but the bar closes against that pressure direction, the aggressive participant is trapped and forced to unwind. Fade the trapped side.",
	defaultParams: {
		pressureLookback: 20,
		exhaustionRank: 90 },
	paramLabels: {
		pressureLookback: "Pressure Lookback",
		exhaustionRank: "Exhaustion Rank" },
	normalizeParams: normalizeInitiativePressureRankExhaustionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativePressureRankExhaustionParams(params);
		const lookback = p.pressureLookback as number;
		const rankThreshold = p.exhaustionRank as number / 100;
		if (cleanData.length < lookback + 2) return [];

		const ipSeries = buildInitiativePressureSeries(cleanData, lookback);
		const ipClean = ipSeries.map(v => v ?? 0);
		const ipRank = buildPercentileRank(ipClean, lookback);

		return createSignalLoop(cleanData, [ipRank], (i) => {
			if (i < lookback) return null;
			const rank = ipRank[i];
			if (rank === null) return null;

			const bullishBar = cleanData[i].close > cleanData[i].open;

			if (rank < (1 - rankThreshold) && bullishBar) {
				return createBuySignal(cleanData, i, `Extreme selling IP rank (${(rank * 100).toFixed(0)}%) but bar closed bullish — sellers trapped`);
			}
			if (rank > rankThreshold && !bullishBar) {
				return createSellSignal(cleanData, i, `Extreme buying IP rank (${(rank * 100).toFixed(0)}%) but bar closed bearish — buyers trapped`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pressureLookback", "exhaustionRank"] } };
