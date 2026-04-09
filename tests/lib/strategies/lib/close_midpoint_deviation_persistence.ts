import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeCloseMidpointDeviationPersistenceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
		streakMin: Math.max(2, Math.round(params.streakMin ?? 5)) };
}

export const close_midpoint_deviation_persistence: Strategy = {
	name: "Close Midpoint Deviation Persistence",
	description: "When the close-location series (close vs midpoint deviation) streaks persistently in one direction beyond a threshold, the market is showing one-sided settlement conviction. Fade the streak as snapback risk increases.",
	defaultParams: {
		lookback: 20,
		streakMin: 5 },
	paramLabels: {
		lookback: "Lookback",
		streakMin: "Minimum Streak" },
	normalizeParams: normalizeCloseMidpointDeviationPersistenceParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseMidpointDeviationPersistenceParams(params);
		const lookback = p.lookback as number;
		const streakMin = p.streakMin as number;
		if (cleanData.length < lookback + 2) return [];

		const clSeries = buildCloseLocationSeries(cleanData);
		const signs = clSeries.map(v => v > 0 ? 1 : v < 0 ? -1 : 0);
		const streak = buildStreakCount(signs);

		return createSignalLoop(cleanData, [streak], (i) => {
			if (i < lookback) return null;
			const s = streak[i];
			if (s === null) return null;

			if (s >= streakMin) {
				return createSellSignal(cleanData, i, `Persistent above-midpoint streak (${s} bars) — snapback risk`);
			}
			if (s <= -streakMin) {
				return createBuySignal(cleanData, i, `Persistent below-midpoint streak (${Math.abs(s)} bars) — snapback risk`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "streakMin"] } };
