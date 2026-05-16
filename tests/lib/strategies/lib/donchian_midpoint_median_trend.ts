import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";
import { calculateDonchianChannels } from "../indicators";

function normalizeDonchianMidpointMedianTrendParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		donchian_period: Math.max(2, Math.round(params.donchian_period ?? 20)),
		median_lookback: Math.max(3, Math.round(params.median_lookback ?? 40)),
	};
}

export const donchian_midpoint_median_trend: Strategy = {
	name: "Donchian Midpoint Median Trend",
	description: "Extracts the structural center of price extremes by taking the rolling median of the Donchian Channel midpoint, capturing pure geometric momentum.",
	defaultParams: {
		donchian_period: 20,
		median_lookback: 40,
	},
	paramLabels: {
		donchian_period: "Donchian Period",
		median_lookback: "Median Lookback",
	},
	normalizeParams: normalizeDonchianMidpointMedianTrendParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDonchianMidpointMedianTrendParams(params);
		const donchianPeriod = p.donchian_period as number;
		const medianLookback = p.median_lookback as number;
		if (cleanData.length < Math.max(donchianPeriod, medianLookback) + 2) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const donchian = calculateDonchianChannels(highs, lows, donchianPeriod);
		const midpoints: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			midpoints[i] = donchian.middle[i] ?? 0;
		}
		const medianMid = buildRollingMedian(midpoints, medianLookback);

		return createSignalLoop(cleanData, [donchian.middle, medianMid], (i) => {
			const d = donchian.middle[i];
			const m = medianMid[i];
			if (d === null || m === null) return null;

			if (d > m) {
				return createBuySignal(cleanData, i, "Donchian midpoint above its rolling median");
			}
			if (d < m) {
				return createSellSignal(cleanData, i, "Donchian midpoint below its rolling median");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["donchian_period", "median_lookback"],
	},
};
