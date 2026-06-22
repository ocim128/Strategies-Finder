import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
		pressureThreshold: Math.max(0.51, Math.min(0.99, Number(params.pressureThreshold ?? 0.75))),
		volumeMinPercentile: Math.max(0.01, Math.min(0.99, Number(params.volumeMinPercentile ?? 0.40))),
	};
}

export const initiative_pressure_percentile_drift: Strategy = {
	name: "Initiative Pressure Percentile Drift",
	description: "Chases ratio trends that are confirmed by sustained buyer/seller initiative pressure and healthy relative volume.",
	defaultParams: {
		lookback: 25,
		pressureThreshold: 0.75,
		volumeMinPercentile: 0.40,
	},
	paramLabels: {
		lookback: "Lookback Window",
		pressureThreshold: "Pressure Threshold",
		volumeMinPercentile: "Min Volume Percentile",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const pressureThreshold = p.pressureThreshold as number;
		const volumeMinPercentile = p.volumeMinPercentile as number;
		if (cleanData.length < lookback * 2) return [];

		const volumes = getVolumes(cleanData);
		const volumePercentile = buildPercentileRank(volumes, lookback);

		const pressure = buildInitiativePressureSeries(cleanData, lookback);
		const cleanPressure = pressure.map(v => v !== null ? v : 0);
		const pressurePercentile = buildPercentileRank(cleanPressure, lookback);

		return createSignalLoop(cleanData, [volumePercentile, pressurePercentile], (i) => {
			if (i < lookback * 2) return null;
			const volPct = volumePercentile[i];
			const pressPct = pressurePercentile[i];
			if (volPct === null || pressPct === null) return null;

			if (volPct <= volumeMinPercentile) return null;

			if (pressPct > pressureThreshold) {
				return createBuySignal(cleanData, i, `Initiative pressure percentile (${pressPct.toFixed(2)}) > ${pressureThreshold} with volume percentile (${volPct.toFixed(2)}) > ${volumeMinPercentile}`);
			}
			if (pressPct < (1 - pressureThreshold)) {
				return createSellSignal(cleanData, i, `Initiative pressure percentile (${pressPct.toFixed(2)}) < ${(1 - pressureThreshold).toFixed(2)} with volume percentile (${volPct.toFixed(2)}) > ${volumeMinPercentile}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "pressureThreshold", "volumeMinPercentile"],
	},
};
