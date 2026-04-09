import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingMedian, buildPercentileRank } from "./price-action-statistics-core";

function normalizeVolumeRankParticipationDivergenceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 30)),
		vol_rank_max: Math.max(0.01, Math.min(1, Number(params.vol_rank_max ?? 0.15))) };
}

export const volume_rank_participation_divergence: Strategy = {
	name: "Volume Rank Participation Divergence",
	description: "When price makes directional progress while volume percentile rank collapses, institutional participation has abandoned the move, favoring reversal.",
	defaultParams: {
		lookback: 30,
		vol_rank_max: 0.15 },
	paramLabels: {
		lookback: "Lookback",
		vol_rank_max: "Max Volume Rank" },
	normalizeParams: normalizeVolumeRankParticipationDivergenceParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeRankParticipationDivergenceParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const median = buildRollingMedian(closes, p.lookback);
		const volRank = buildPercentileRank(volumes, p.lookback);

		return createSignalLoop(cleanData, [median, volRank], (i) => {
			if (i < p.lookback) return null;
			const med = median[i];
			const rank = volRank[i];
			if (med === null || rank === null) return null;

			if (rank >= p.vol_rank_max) return null;

			if (closes[i] < med) {
				return createBuySignal(cleanData, i, `Price below median, vol rank ${rank.toFixed(3)} < ${p.vol_rank_max}, sellers vanished`);
			}
			if (closes[i] > med) {
				return createSellSignal(cleanData, i, `Price above median, vol rank ${rank.toFixed(3)} < ${p.vol_rank_max}, buyers vanished`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "vol_rank_max"] } };
