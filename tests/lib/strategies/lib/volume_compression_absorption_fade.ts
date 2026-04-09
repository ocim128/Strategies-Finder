import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingZScore } from "./price-action-statistics-core";

function normalizeVolumeCompressionAbsorptionFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 40)),
		vol_z_thresh: Math.max(0.5, Math.abs(Number(params.vol_z_thresh ?? 2.0))),
		range_z_thresh: Number(params.range_z_thresh ?? -1.5) };
}

export const volume_compression_absorption_fade: Strategy = {
	name: "Volume Compression Absorption Fade",
	description: "Extremely high volume during a tightly compressed range indicates iceberg liquidity absorbing the move. The bar direction reveals which side is absorbing.",
	defaultParams: {
		lookback: 40,
		vol_z_thresh: 2.0,
		range_z_thresh: -1.5 },
	paramLabels: {
		lookback: "Lookback",
		vol_z_thresh: "Min Volume Z-Score",
		range_z_thresh: "Max Range Z-Score" },
	normalizeParams: normalizeVolumeCompressionAbsorptionFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeCompressionAbsorptionFadeParams(params);
		if (cleanData.length < p.lookback) return [];

		const volumes = getVolumes(cleanData);
		const volZ = buildRollingZScore(volumes, p.lookback);
		const trueRange = extractBarMetricSeries(cleanData, "trueRange");
		const trZ = buildRollingZScore(trueRange, p.lookback);

		return createSignalLoop(cleanData, [volZ, trZ], (i) => {
			if (i < p.lookback) return null;
			const vz = volZ[i];
			const rz = trZ[i];
			if (vz === null || rz === null) return null;

			if (vz <= p.vol_z_thresh || rz >= p.range_z_thresh) return null;

			if (cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, `VolZ ${vz.toFixed(2)} > ${p.vol_z_thresh}, TRZ ${rz.toFixed(2)} < ${p.range_z_thresh}, sellers absorbed`);
			}
			return createSellSignal(cleanData, i, `VolZ ${vz.toFixed(2)} > ${p.vol_z_thresh}, TRZ ${rz.toFixed(2)} < ${p.range_z_thresh}, buyers absorbed`);
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "vol_z_thresh", "range_z_thresh"] } };
