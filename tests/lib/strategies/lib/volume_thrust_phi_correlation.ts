import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRateOfChange, buildRollingCorrelation, buildRollingZScore } from "./price-action-statistics-core";

function normalizeVolumeThrustPhiCorrelationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		corr_lookback: Math.max(3, Math.round(params.corr_lookback ?? 20)),
		corr_ceiling: Math.max(-1, Math.min(1, Number(params.corr_ceiling ?? 0.382))),
		vol_z_min: Math.max(0, Number(params.vol_z_min ?? 1.5)),
	};
}

export const volume_thrust_phi_correlation: Strategy = {
	name: "Volume Thrust Phi Correlation",
	description: "If rolling correlation between volume and price drops below 0.382 during a high-volume thrust, the move has lost structural participation and is vulnerable to reversion.",
	defaultParams: {
		corr_lookback: 20,
		corr_ceiling: 0.382,
		vol_z_min: 1.5,
	},
	paramLabels: {
		corr_lookback: "Correlation Lookback",
		corr_ceiling: "Correlation Ceiling",
		vol_z_min: "Volume Z Min",
	},
	normalizeParams: normalizeVolumeThrustPhiCorrelationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeThrustPhiCorrelationParams(params);
		if (cleanData.length < p.corr_lookback) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const roc = buildRateOfChange(closes, 1);
		const rocClean = roc.map(v => v ?? 0);
		const corr = buildRollingCorrelation(rocClean, volumes, p.corr_lookback);
		const volZ = buildRollingZScore(volumes, p.corr_lookback);

		return createSignalLoop(cleanData, [corr, roc, volZ], (i) => {
			if (i < p.corr_lookback) return null;
			const c = corr[i];
			const rocVal = roc[i];
			const vz = volZ[i];
			if (c === null || rocVal === null || vz === null) return null;

			if (vz > p.vol_z_min && rocVal < 0 && c < p.corr_ceiling)
				return createBuySignal(cleanData, i, "High-volume selloff with collapsed correlation");
			if (vz > p.vol_z_min && rocVal > 0 && c < p.corr_ceiling)
				return createSellSignal(cleanData, i, "High-volume rally with collapsed correlation");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["corr_lookback", "corr_ceiling", "vol_z_min"],
	},
};





