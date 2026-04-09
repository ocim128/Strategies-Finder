import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeVolumeProfilePhiVacuumParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		vp_lookback: Math.max(5, Math.round(params.vp_lookback ?? 50)),
		phi_distance: Math.max(0.01, Math.abs(Number(params.phi_distance ?? 0.382))),
		phi_vol_rank: Math.max(0.01, Math.min(1, Number(params.phi_vol_rank ?? 0.382))) };
}

export const volume_profile_phi_vacuum: Strategy = {
	name: "Volume Profile Phi Vacuum",
	description: "Price extending beyond the POC by the golden ratio of the trailing spread with a low volume percentile rank is an unbacked anomaly destined to fail.",
	defaultParams: {
		vp_lookback: 50,
		phi_distance: 0.382,
		phi_vol_rank: 0.382 },
	paramLabels: {
		vp_lookback: "VP Lookback",
		phi_distance: "Phi Distance",
		phi_vol_rank: "Phi Volume Rank" },
	normalizeParams: normalizeVolumeProfilePhiVacuumParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeProfilePhiVacuumParams(params);
		if (cleanData.length < p.vp_lookback) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const vp = calculateVolumeProfile(cleanData, p.vp_lookback, 10);
		const { highest, lowest } = buildTrailingHighLow(cleanData, p.vp_lookback);
		const volRank = buildPercentileRank(volumes, p.vp_lookback);

		return createSignalLoop(cleanData, [vp.poc, highest, lowest, volRank], (i) => {
			if (i < p.vp_lookback) return null;
			const poc = vp.poc[i];
			const hi = highest[i];
			const lo = lowest[i];
			const rank = volRank[i];
			if (poc === null || hi === null || lo === null || rank === null) return null;

			const spread = hi - lo;
			if (spread <= 0) return null;
			if (rank >= p.phi_vol_rank) return null;

			const distance = spread * p.phi_distance;

			if (closes[i] < poc - distance) {
				return createBuySignal(cleanData, i, `Close ${(closes[i]).toFixed(2)} < POC ${poc.toFixed(2)} - phi * spread, vol rank ${rank.toFixed(2)} low`);
			}
			if (closes[i] > poc + distance) {
				return createSellSignal(cleanData, i, `Close ${(closes[i]).toFixed(2)} > POC ${poc.toFixed(2)} + phi * spread, vol rank ${rank.toFixed(2)} low`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["vp_lookback", "phi_distance", "phi_vol_rank"] } };
