import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeCloseAcceptanceVolumeConvictionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 30)),
		convictionRank: Math.max(50, Math.min(99, Number(params.convictionRank ?? 85))) };
}

export const close_acceptance_volume_conviction: Strategy = {
	name: "Close Acceptance Volume Conviction",
	description: "When close acceptance reaches an extreme and volume simultaneously confirms with a high percentile rank, the market has produced a high-conviction directional settlement backed by genuine participation. Trade continuation.",
	defaultParams: {
		lookback: 30,
		convictionRank: 85 },
	paramLabels: {
		lookback: "Lookback",
		convictionRank: "Conviction Rank" },
	normalizeParams: normalizeCloseAcceptanceVolumeConvictionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseAcceptanceVolumeConvictionParams(params);
		const lookback = p.lookback as number;
		const rankThreshold = p.convictionRank as number / 100;
		if (cleanData.length < lookback + 2) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const absAcceptance = acceptance.map(v => Math.abs(v));
		const accRank = buildPercentileRank(absAcceptance, lookback);
		const volumes = getVolumes(cleanData);
		const volRank = buildPercentileRank(volumes, lookback);

		return createSignalLoop(cleanData, [accRank, volRank], (i) => {
			if (i < lookback) return null;
			const ar = accRank[i];
			const vr = volRank[i];
			if (ar === null || vr === null) return null;
			if (ar < rankThreshold || vr < rankThreshold) return null;

			if (acceptance[i] > 0) {
				return createBuySignal(cleanData, i, `High-conviction bullish (acc rank ${(ar * 100).toFixed(0)}%, vol rank ${(vr * 100).toFixed(0)}%)`);
			}
			if (acceptance[i] < 0) {
				return createSellSignal(cleanData, i, `High-conviction bearish (acc rank ${(ar * 100).toFixed(0)}%, vol rank ${(vr * 100).toFixed(0)}%)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "convictionRank"] } };





