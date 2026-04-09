import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildEfficiencyRatio, buildPercentileRank } from "./price-action-statistics-core";

function normalizeEfficiencyRatioVolumeConfirmationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 30)),
		volRankMin: Math.max(0, Math.min(100, Number(params.volRankMin ?? 70))) };
}

export const efficiency_ratio_volume_confirmation: Strategy = {
	name: "Efficiency Ratio Volume Confirmation",
	description: "When the efficiency ratio indicates a strong directional trend and volume simultaneously confirms with a high percentile rank, the move is backed by genuine participation. Enter in the ER direction. When ER is high but volume is low, the move is suspect — fade it.",
	defaultParams: {
		lookback: 30,
		volRankMin: 70 },
	paramLabels: {
		lookback: "Lookback",
		volRankMin: "Volume Rank Min" },
	normalizeParams: normalizeEfficiencyRatioVolumeConfirmationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEfficiencyRatioVolumeConfirmationParams(params);
		const lookback = p.lookback as number;
		const volRankMin = p.volRankMin as number / 100;
		if (cleanData.length < lookback + 2) return [];

		const volumes = getVolumes(cleanData);
		const er = buildEfficiencyRatio(cleanData, lookback);
		const volRank = buildPercentileRank(volumes, lookback);

		return createSignalLoop(cleanData, [er, volRank], (i) => {
			if (i < lookback) return null;
			const e = er[i];
			const vr = volRank[i];
			if (e === null || vr === null) return null;

			const highER = Math.abs(e) > 0.5;

			if (highER && vr >= volRankMin) {
				if (e > 0) {
					return createBuySignal(cleanData, i, `Strong efficient uptrend (ER=${e.toFixed(2)}) with volume confirmation (rank ${(vr * 100).toFixed(0)}%)`);
				}
				return createSellSignal(cleanData, i, `Strong efficient downtrend (ER=${e.toFixed(2)}) with volume confirmation (rank ${(vr * 100).toFixed(0)}%)`);
			}

			if (highER && vr < 0.3) {
				if (e > 0) {
					return createSellSignal(cleanData, i, `Efficient uptrend without volume (ER=${e.toFixed(2)}, vol rank ${(vr * 100).toFixed(0)}%) — suspect, fade`);
				}
				return createBuySignal(cleanData, i, `Efficient downtrend without volume (ER=${e.toFixed(2)}, vol rank ${(vr * 100).toFixed(0)}%) — suspect, fade`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "volRankMin"] } };
