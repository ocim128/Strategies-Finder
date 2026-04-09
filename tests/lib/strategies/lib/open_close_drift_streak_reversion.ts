import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildStreakCount } from "./price-action-statistics-core";

function normalizeOpenCloseDriftStreakReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		streakThreshold: Math.max(2, Math.round(params.streakThreshold ?? 4)),
		minBodyPct: Math.max(0, Math.min(1, Number(params.minBodyPct ?? 0.2))) };
}

export const open_close_drift_streak_reversion: Strategy = {
	name: "Open-Close Drift Streak Reversion",
	description: "The within-bar drift (close minus open) measures intrabar settlement behavior. When this drift persists in the same direction for consecutive bars with meaningful body size, the settlement pattern is extreme and likely to revert.",
	defaultParams: {
		streakThreshold: 4,
		minBodyPct: 0.2 },
	paramLabels: {
		streakThreshold: "Streak Threshold",
		minBodyPct: "Min Body %" },
	normalizeParams: normalizeOpenCloseDriftStreakReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeOpenCloseDriftStreakReversionParams(params);
		const streakThreshold = p.streakThreshold as number;
		const minBodyPct = p.minBodyPct as number;
		if (cleanData.length < streakThreshold + 2) return [];

		const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
		const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");

		const bullishFlags = new Array(cleanData.length).fill(0);
		const bearishFlags = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			if (bodyDir[i] > 0 && bodyPct[i] >= minBodyPct) bullishFlags[i] = 1;
			if (bodyDir[i] < 0 && bodyPct[i] >= minBodyPct) bearishFlags[i] = -1;
		}

		const bullishStreaks = buildStreakCount(bullishFlags);
		const bearishStreaks = buildStreakCount(bearishFlags);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < streakThreshold) return null;

			if (bearishStreaks[i] <= -streakThreshold) {
				return createBuySignal(cleanData, i, `Bearish drift streak exhausted (${bearishStreaks[i]} bars)`);
			}
			if (bullishStreaks[i] >= streakThreshold) {
				return createSellSignal(cleanData, i, `Bullish drift streak exhausted (${bullishStreaks[i]} bars)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["streakThreshold", "minBodyPct"] } };
