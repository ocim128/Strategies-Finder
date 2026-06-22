import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getWeightedClosePrices,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

type WeightedPercentilePrepared = {
	data: OHLCVData[];
	weightedCloses: number[];
	percentileByLookback: Map<number, (number | null)[]>;
};

function normalizeWeightedPercentileParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
	};
}

function prepareWeightedPercentileData(data: OHLCVData[]): WeightedPercentilePrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		weightedCloses: getWeightedClosePrices(clean),
		percentileByLookback: new Map(),
	};
}

function getPreparedWeightedPercentileData(
	preparedData: unknown,
	data: OHLCVData[]
): WeightedPercentilePrepared {
	if (preparedData && typeof preparedData === "object" && "percentileByLookback" in preparedData) {
		return preparedData as WeightedPercentilePrepared;
	}
	return prepareWeightedPercentileData(data);
}

export const weighted_close_percentile_reversion: Strategy = {
	name: "Weighted Close Percentile Reversion",
	description: "Fades the weighted close price when it reaches extreme historical percentile ranks (bottom 2% or top 2%).",
	defaultParams: {
		lookback: 40,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeWeightedPercentileParams,
	prepareFinderData: (data) => prepareWeightedPercentileData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedWeightedPercentileData(preparedData, data);
		const p = normalizeWeightedPercentileParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let percentiles = prepared.percentileByLookback.get(lookback);
		if (!percentiles) {
			percentiles = buildPercentileRank(prepared.weightedCloses, lookback);
			prepared.percentileByLookback.set(lookback, percentiles);
		}

		return createSignalLoop(prepared.data, [percentiles], (i) => {
			if (i < lookback) return null;
			const pct = percentiles[i];
			if (pct === null) return null;

			if (pct <= 0.02) {
				return createBuySignal(prepared.data, i, `Weighted close percentile (${pct.toFixed(3)}) <= 0.02`);
			}
			if (pct >= 0.98) {
				return createSellSignal(prepared.data, i, `Weighted close percentile (${pct.toFixed(3)}) >= 0.98`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		weighted_close_percentile_reversion.executePrepared?.(prepareWeightedPercentileData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
