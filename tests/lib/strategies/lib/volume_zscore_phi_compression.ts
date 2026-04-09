import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { extractBarMetricSeries, buildRollingZScore } from "./price-action-statistics-core";

function normalizeVolumeZscorePhiCompressionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		vol_z_min: Math.max(0, Number(params.vol_z_min ?? 1.5)),
		phi_compression: Math.max(0.01, Math.abs(Number(params.phi_compression ?? 0.382))) };
}

export const volume_zscore_phi_compression: Strategy = {
	name: "Volume Z-Score Phi Compression",
	description: "High volume effort (Z-score > 1.5) combined with True Range compressed below the golden ratio of the trailing spread proves massive institutional battle lines are drawn inside a coil.",
	defaultParams: {
		lookback: 20,
		vol_z_min: 1.5,
		phi_compression: 0.382 },
	paramLabels: {
		lookback: "Lookback",
		vol_z_min: "Min Volume Z-Score",
		phi_compression: "Phi Compression" },
	normalizeParams: normalizeVolumeZscorePhiCompressionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeZscorePhiCompressionParams(params);
		if (cleanData.length < p.lookback) return [];

		const volumes = getVolumes(cleanData);
		const volZ = buildRollingZScore(volumes, p.lookback);
		const trueRange = extractBarMetricSeries(cleanData, "trueRange");
		const { highest, lowest } = buildTrailingHighLow(cleanData, p.lookback);

		return createSignalLoop(cleanData, [volZ, highest, lowest], (i) => {
			if (i < p.lookback) return null;
			const vz = volZ[i];
			const hi = highest[i];
			const lo = lowest[i];
			if (vz === null || hi === null || lo === null) return null;

			const spread = hi - lo;
			if (spread <= 0) return null;
			if (vz <= p.vol_z_min) return null;
			if (trueRange[i] >= spread * p.phi_compression) return null;

			const bullishBar = cleanData[i].close > cleanData[i].open;

			if (bullishBar) {
				return createBuySignal(cleanData, i, `VolZ ${vz.toFixed(2)} > ${p.vol_z_min}, TR compressed < phi * spread — bullish coil`);
			}
			return createSellSignal(cleanData, i, `VolZ ${vz.toFixed(2)} > ${p.vol_z_min}, TR compressed < phi * spread — bearish coil`);
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "vol_z_min", "phi_compression"] } };
