import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingZScore, buildRollingStdDev, buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 25))),
		volumeZThreshold: Math.max(0.1, Number(params.volumeZThreshold ?? 1.5)),
		volPercentileThreshold: Math.max(0.01, Math.min(0.99, Number(params.volPercentileThreshold ?? 0.80))),
	};
}

export const volume_zscore_volatility_expansion: Strategy = {
	name: "Volume Z-Score Volatility Expansion",
	description: "Chases ratio breakouts when a sudden spike in proxy volume z-score is accompanied by a volatility expansion.",
	defaultParams: {
		lookback: 25,
		volumeZThreshold: 1.5,
		volPercentileThreshold: 0.80,
	},
	paramLabels: {
		lookback: "Lookback Window",
		volumeZThreshold: "Volume Z-Score Threshold",
		volPercentileThreshold: "Volatility Percentile Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const volumeZThreshold = p.volumeZThreshold as number;
		const volPercentileThreshold = p.volPercentileThreshold as number;
		if (cleanData.length < lookback * 2) return [];

		const volumes = getVolumes(cleanData);
		const volumeZ = buildRollingZScore(volumes, lookback);

		const closes = getCloses(cleanData);
		const returns = buildRateOfChange(closes, 1).map(v => v !== null ? v : 0);
		const volatility = buildRollingStdDev(returns, lookback);
		const cleanVol = volatility.map(v => v !== null ? v : 0);
		const volPercentile = buildPercentileRank(cleanVol, lookback);

		const closeLocation = buildCloseLocationSeries(cleanData);

		return createSignalLoop(cleanData, [volumeZ, volPercentile], (i) => {
			if (i < lookback * 2) return null;
			const vz = volumeZ[i];
			const vp = volPercentile[i];
			const cl = closeLocation[i];
			if (vz === null || vp === null || cl === null) return null;

			if (vz <= volumeZThreshold) return null;
			if (vp <= volPercentileThreshold) return null;

			if (cl > 0.7) {
				return createBuySignal(cleanData, i, `Breakout buy: volume z-score (${vz.toFixed(2)}) > ${volumeZThreshold}, volatility percentile (${vp.toFixed(2)}) > ${volPercentileThreshold}, close location ${cl.toFixed(2)} > 0.7`);
			}
			if (cl < 0.3) {
				return createSellSignal(cleanData, i, `Breakout sell: volume z-score (${vz.toFixed(2)}) > ${volumeZThreshold}, volatility percentile (${vp.toFixed(2)}) > ${volPercentileThreshold}, close location ${cl.toFixed(2)} < 0.3`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "volumeZThreshold", "volPercentileThreshold"],
	},
};
