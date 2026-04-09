import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildStreakCount } from "./price-action-statistics-core";

function normalizeBodyMidpointDeltaConvictionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		streakThreshold: Math.max(2, Math.round(params.streakThreshold ?? 4)),
		minDeltaPct: Math.max(0, Math.abs(Number(params.minDeltaPct ?? 0.05))) };
}

export const body_midpoint_delta_conviction: Strategy = {
	name: "Body Midpoint Delta Conviction",
	description: "The delta between body midpoint and bar midpoint isolates where the body settled relative to the bar's equilibrium. When this delta persists on one side for consecutive bars, the market is systematically settling away from fair value — directional conviction predicting continuation.",
	defaultParams: {
		streakThreshold: 4,
		minDeltaPct: 0.05 },
	paramLabels: {
		streakThreshold: "Streak Threshold",
		minDeltaPct: "Min Delta %" },
	normalizeParams: normalizeBodyMidpointDeltaConvictionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodyMidpointDeltaConvictionParams(params);
		const streakThreshold = p.streakThreshold as number;
		const minDeltaPct = p.minDeltaPct as number;
		if (cleanData.length < streakThreshold + 2) return [];

		const bodyMidDelta = extractBarMetricSeries(cleanData, "bodyMidDelta");

		const bullishFlags = new Array(cleanData.length).fill(0);
		const bearishFlags = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const range = cleanData[i].high - cleanData[i].low;
			if (range > 0 && Math.abs(bodyMidDelta[i]) / range >= minDeltaPct) {
				if (bodyMidDelta[i] > 0) bullishFlags[i] = 1;
				if (bodyMidDelta[i] < 0) bearishFlags[i] = -1;
			}
		}

		const bullishStreaks = buildStreakCount(bullishFlags);
		const bearishStreaks = buildStreakCount(bearishFlags);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < streakThreshold) return null;

			if (bullishStreaks[i] >= streakThreshold) {
				return createBuySignal(cleanData, i, `Bullish body-midpoint delta conviction (streak ${bullishStreaks[i]})`);
			}
			if (bearishStreaks[i] <= -streakThreshold) {
				return createSellSignal(cleanData, i, `Bearish body-midpoint delta conviction (streak ${bearishStreaks[i]})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["streakThreshold", "minDeltaPct"] } };
