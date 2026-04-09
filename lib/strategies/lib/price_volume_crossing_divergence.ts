import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildThresholdCrossingCount } from "./price-action-statistics-core";

function normalizePriceVolumeCrossingDivergenceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 30)),
		crossingRatio: Math.max(1, Math.abs(Number(params.crossingRatio ?? 3.0))) };
}

export const price_volume_crossing_divergence: Strategy = {
	name: "Price Volume Crossing Divergence",
	description: "When price has few rolling-average crossings (persistent direction) while volume has many (churning), the directional move lacks stable participation — exhaustion. Fade the price direction.",
	defaultParams: {
		lookback: 30,
		crossingRatio: 3.0 },
	paramLabels: {
		lookback: "Lookback",
		crossingRatio: "Crossing Ratio" },
	normalizeParams: normalizePriceVolumeCrossingDivergenceParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizePriceVolumeCrossingDivergenceParams(params);
		const lookback = p.lookback as number;
		const ratioThreshold = p.crossingRatio as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const avgClose = buildRollingAverage(closes, lookback);
		const avgVol = buildRollingAverage(volumes, lookback);

		const closeVsAvg = closes.map((c, i) => avgClose[i] !== null ? c - avgClose[i]! : 0);
		const volVsAvg = volumes.map((v, i) => avgVol[i] !== null ? v - avgVol[i]! : 0);

		const priceCrossings = buildThresholdCrossingCount(closeVsAvg, lookback, 0);
		const volCrossings = buildThresholdCrossingCount(volVsAvg, lookback, 0);

		return createSignalLoop(cleanData, [avgClose, priceCrossings, volCrossings], (i) => {
			if (i < lookback) return null;
			const pc = priceCrossings[i];
			const vc = volCrossings[i];
			const avg = avgClose[i];
			if (pc === null || vc === null || avg === null) return null;

			const denom = Math.max(pc, 1);
			if (vc / denom <= ratioThreshold) return null;

			if (closes[i] < avg) {
				return createBuySignal(cleanData, i, `Volume churn vs price persistence (vol=${vc}, price=${pc}), close below avg — fade long`);
			}
			if (closes[i] > avg) {
				return createSellSignal(cleanData, i, `Volume churn vs price persistence (vol=${vc}, price=${pc}), close above avg — fade short`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "crossingRatio"] } };
