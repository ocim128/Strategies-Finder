import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingStdDev, buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		volThreshold: Math.max(0.01, Math.min(0.99, Number(params.volThreshold ?? 0.80))),
	};
}

export const volatility_expansion_close_acceptance: Strategy = {
	name: "Volatility Expansion Close Acceptance",
	description: "Follows breakouts when return volatility spikes to a high percentile, entering in the direction of the close location breakout.",
	defaultParams: {
		lookback: 30,
		volThreshold: 0.80,
	},
	paramLabels: {
		lookback: "Lookback Window",
		volThreshold: "Volatility Percentile Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const volThreshold = p.volThreshold as number;
		if (cleanData.length < lookback * 2) return [];

		const closes = getCloses(cleanData);
		const returns = buildRateOfChange(closes, 1).map(v => v !== null ? v : 0);
		const volatility = buildRollingStdDev(returns, lookback);
		const cleanVol = volatility.map(v => v !== null ? v : 0);
		const volPercentile = buildPercentileRank(cleanVol, lookback);

		const closeLocation = buildCloseLocationSeries(cleanData);

		return createSignalLoop(cleanData, [volPercentile], (i) => {
			if (i < lookback * 2) return null;
			const vp = volPercentile[i];
			const cl = closeLocation[i];
			if (vp === null || cl === null) return null;

			if (vp <= volThreshold) return null;

			if (cl > 0.75) {
				return createBuySignal(cleanData, i, `Volatility expansion: percentile (${vp.toFixed(2)}) > ${volThreshold}, close location ${cl.toFixed(2)} > 0.75`);
			}
			if (cl < 0.25) {
				return createSellSignal(cleanData, i, `Volatility expansion: percentile (${vp.toFixed(2)}) > ${volThreshold}, close location ${cl.toFixed(2)} < 0.25`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "volThreshold"],
	},
};
