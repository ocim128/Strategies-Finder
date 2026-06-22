import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingMinMax } from "./price-action-statistics-core";

type PriceChannelBreakoutPrepared = {
	data: OHLCVData[];
	closes: number[];
	ranges: number[];
	minMaxByLookback: Map<number, { min: (number | null)[]; max: (number | null)[] }>;
	rangePercentileByLookback: Map<number, (number | null)[]>;
};

function normalizePriceChannelParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
		rangeThreshold: Math.max(0.01, Math.min(0.99, Number(params.rangeThreshold ?? 0.60))),
	};
}

function preparePriceChannelData(data: OHLCVData[]): PriceChannelBreakoutPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		closes: getCloses(clean),
		ranges: buildRangeSeries(clean),
		minMaxByLookback: new Map(),
		rangePercentileByLookback: new Map(),
	};
}

function getPreparedPriceChannelData(preparedData: unknown, data: OHLCVData[]): PriceChannelBreakoutPrepared {
	if (preparedData && typeof preparedData === "object" && "rangePercentileByLookback" in preparedData) {
		return preparedData as PriceChannelBreakoutPrepared;
	}
	return preparePriceChannelData(data);
}

export const price_channel_breakout_chase: Strategy = {
	name: "Price Channel Breakout Chase",
	description: "Chases a breakout when the close price breaks out of its trailing channel, confirmed by range expansion.",
	defaultParams: {
		lookback: 40,
		rangeThreshold: 0.60,
	},
	paramLabels: {
		lookback: "Lookback",
		rangeThreshold: "Range Percentile Threshold",
	},
	normalizeParams: normalizePriceChannelParams,
	prepareFinderData: (data) => preparePriceChannelData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedPriceChannelData(preparedData, data);
		const p = normalizePriceChannelParams(params);
		const lookback = p.lookback as number;
		const rangeThreshold = p.rangeThreshold as number;
		if (prepared.data.length < lookback + 1) return [];

		let minMax = prepared.minMaxByLookback.get(lookback);
		if (!minMax) {
			// includeCurrent = false to exclude the current index so we compare closes[i] against previous lookback bars' min/max
			minMax = buildRollingMinMax(prepared.closes, lookback, false);
			prepared.minMaxByLookback.set(lookback, minMax);
		}

		let rangePercentile = prepared.rangePercentileByLookback.get(lookback);
		if (!rangePercentile) {
			rangePercentile = buildPercentileRank(prepared.ranges, lookback);
			prepared.rangePercentileByLookback.set(lookback, rangePercentile);
		}

		const { min, max } = minMax;

		return createSignalLoop(prepared.data, [min, max, rangePercentile], (i) => {
			if (i < lookback) return null;
			const minVal = min[i];
			const maxVal = max[i];
			const rp = rangePercentile[i];
			if (minVal === null || maxVal === null || rp === null) return null;

			const close = prepared.closes[i];

			if (close >= maxVal && rp > rangeThreshold) {
				return createBuySignal(prepared.data, i, `Channel high breakout: close (${close.toFixed(4)}) >= max (${maxVal.toFixed(4)}) with range percentile (${rp.toFixed(2)}) > threshold (${rangeThreshold})`);
			}
			if (close <= minVal && rp > rangeThreshold) {
				return createSellSignal(prepared.data, i, `Channel low breakdown: close (${close.toFixed(4)}) <= min (${minVal.toFixed(4)}) with range percentile (${rp.toFixed(2)}) > threshold (${rangeThreshold})`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		price_channel_breakout_chase.executePrepared?.(preparePriceChannelData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "rangeThreshold"],
	},
};
