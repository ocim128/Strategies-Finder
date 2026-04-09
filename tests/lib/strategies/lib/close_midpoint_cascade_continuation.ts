import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { extractBarMetricSeries, buildStreakCount, buildPercentileRank } from "./price-action-statistics-core";

function normalizeCloseMidpointCascadeContinuationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		deviationRank: Math.max(50, Math.min(99, Number(params.deviationRank ?? 90))),
		minCascadeStreak: Math.max(2, Math.round(params.minCascadeStreak ?? 3)) };
}

export const close_midpoint_cascade_continuation: Strategy = {
	name: "Close Midpoint Cascade Continuation",
	description: "When closeMidpointDev is extreme and escalating over consecutive bars with rising volume, price is cascading from fair value with increasing force. Trade continuation for one bar because the dealer hedging cascade has escalating momentum.",
	defaultParams: {
		deviationRank: 90,
		minCascadeStreak: 3 },
	paramLabels: {
		deviationRank: "Deviation Rank Min",
		minCascadeStreak: "Min Cascade Streak" },
	normalizeParams: normalizeCloseMidpointCascadeContinuationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseMidpointCascadeContinuationParams(params);
		const deviationRank = p.deviationRank as number;
		const minStreak = p.minCascadeStreak as number;
		if (cleanData.length < 33) return [];

		const devSeries = extractBarMetricSeries(cleanData, "closeMidpointDev");
		const absDevSeries = devSeries.map(v => Math.abs(v));
		const absDevRank = buildPercentileRank(absDevSeries, 30);
		const volumes = getVolumes(cleanData);
		const volRank = buildPercentileRank(volumes, 30);

		const bullishFlags = new Array(cleanData.length).fill(0);
		const bearishFlags = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			if (devSeries[i] > 0 && absDevSeries[i] > absDevSeries[i - 1]) bullishFlags[i] = 1;
			if (devSeries[i] < 0 && absDevSeries[i] > absDevSeries[i - 1]) bearishFlags[i] = -1;
		}

		const bullishStreaks = buildStreakCount(bullishFlags);
		const bearishStreaks = buildStreakCount(bearishFlags);

		return createSignalLoop(cleanData, [absDevRank, volRank], (i) => {
			if (i < minStreak + 1) return null;
			const devR = absDevRank[i - 1];
			const volR = volRank[i - 1];
			if (devR === null || volR === null) return null;
			if (devR < deviationRank / 100) return null;
			if (volR < 0.6) return null;

			if (bullishStreaks[i - 1] >= minStreak && devSeries[i - 1] > 0) {
				return createBuySignal(cleanData, i, `Bullish midpoint cascade (streak ${bullishStreaks[i - 1]}, dev rank ${(devR * 100).toFixed(0)}%)`);
			}
			if (bearishStreaks[i - 1] <= -minStreak && devSeries[i - 1] < 0) {
				return createSellSignal(cleanData, i, `Bearish midpoint cascade (streak ${bearishStreaks[i - 1]}, dev rank ${(devR * 100).toFixed(0)}%)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["deviationRank", "minCascadeStreak"] } };
