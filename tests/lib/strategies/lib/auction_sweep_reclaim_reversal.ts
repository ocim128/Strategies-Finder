import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildSweepReclaimSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeAuctionSweepReclaimReversalParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
		reclaim_z_thresh: Math.max(0.5, Math.abs(Number(params.reclaim_z_thresh ?? 2.0))) };
}

export const auction_sweep_reclaim_reversal: Strategy = {
	name: "Auction Sweep Reclaim Reversal",
	description: "When price heavily sweeps a local extremum but immediately reclaims, the auction has failed and trapped late participants. Z-scored severity filters for structural traps.",
	defaultParams: {
		lookback: 20,
		reclaim_z_thresh: 2.0 },
	paramLabels: {
		lookback: "Lookback",
		reclaim_z_thresh: "Reclaim Z-Score Threshold" },
	normalizeParams: normalizeAuctionSweepReclaimReversalParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeAuctionSweepReclaimReversalParams(params);
		if (cleanData.length < p.lookback) return [];

		const sweepSeries = buildSweepReclaimSeries(cleanData, p.lookback);
		const sweepValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			sweepValues[i] = sweepSeries[i] ?? 0;
		}
		const zscore = buildRollingZScore(sweepValues, p.lookback);

		return createSignalLoop(cleanData, [zscore], (i) => {
			if (i < p.lookback) return null;
			const z = zscore[i];
			if (z === null) return null;

			if (z > p.reclaim_z_thresh) {
				return createBuySignal(cleanData, i, `Sweep/reclaim Z ${z.toFixed(2)} > ${p.reclaim_z_thresh}, bullish liquidity trap`);
			}
			if (z < -p.reclaim_z_thresh) {
				return createSellSignal(cleanData, i, `Sweep/reclaim Z ${z.toFixed(2)} < -${p.reclaim_z_thresh}, bearish liquidity trap`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "reclaim_z_thresh"] } };
