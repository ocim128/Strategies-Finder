import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeCloseAcceptanceStreakReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		acceptanceThreshold: Math.max(0, Math.min(1, Number(params.acceptanceThreshold ?? 0.8))),
		streakThreshold: Math.max(2, Math.round(params.streakThreshold ?? 4)) };
}

export const close_acceptance_streak_reversion: Strategy = {
	name: "Close Acceptance Streak Reversion",
	description: "When close acceptance is high and consistently in one direction for consecutive bars, the market is aggressively accepting one side of every bar. This one-sided acceptance creates a crowded position vulnerable to reversal. Fade the streak.",
	defaultParams: {
		acceptanceThreshold: 0.8,
		streakThreshold: 4 },
	paramLabels: {
		acceptanceThreshold: "Acceptance Threshold",
		streakThreshold: "Streak Threshold" },
	normalizeParams: normalizeCloseAcceptanceStreakReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseAcceptanceStreakReversionParams(params);
		const threshold = p.acceptanceThreshold as number;
		const streakReq = p.streakThreshold as number;
		if (cleanData.length < streakReq + 2) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const upperFlags = new Array(cleanData.length).fill(0);
		const lowerFlags = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const mid = (highs[i] + lows[i]) / 2;
			if (Math.abs(acceptance[i]) > threshold) {
				if (closes[i] > mid) upperFlags[i] = 1;
				else if (closes[i] < mid) lowerFlags[i] = -1;
			}
		}

		const upperStreaks = buildStreakCount(upperFlags);
		const lowerStreaks = buildStreakCount(lowerFlags);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < streakReq) return null;

			if (lowerStreaks[i] <= -streakReq) {
				return createBuySignal(cleanData, i, `Bearish acceptance streak exhausted (${lowerStreaks[i]} bars above threshold)`);
			}
			if (upperStreaks[i] >= streakReq) {
				return createSellSignal(cleanData, i, `Bullish acceptance streak exhausted (${upperStreaks[i]} bars above threshold)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["acceptanceThreshold", "streakThreshold"] } };





