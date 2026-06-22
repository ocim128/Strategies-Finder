import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import {
	buildRangeSeries,
	buildCloseLocationSeries,
	buildRollingAverage,
} from "./price-action-frequency-core";

type VolatilityClusteringPrepared = {
	data: OHLCVData[];
	ranges: number[];
	closeLocation: number[];
	avgRangeByLookback: Map<number, (number | null)[]>;
};

function normalizeVolatilityClusteringParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
		threshold: Math.max(0, Number(params.threshold ?? 1.5)),
	};
}

function prepareVolatilityClusteringData(data: OHLCVData[]): VolatilityClusteringPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		ranges: buildRangeSeries(clean),
		closeLocation: buildCloseLocationSeries(clean),
		avgRangeByLookback: new Map(),
	};
}

function getPreparedVolatilityClusteringData(
	preparedData: unknown,
	data: OHLCVData[]
): VolatilityClusteringPrepared {
	if (preparedData && typeof preparedData === "object" && "avgRangeByLookback" in preparedData) {
		return preparedData as VolatilityClusteringPrepared;
	}
	return prepareVolatilityClusteringData(data);
}

export const range_volatility_clustering_breakout: Strategy = {
	name: "Range Volatility Clustering Breakout",
	description: "Chases a breakout when range volatility expands significantly above its average and close location is extreme.",
	defaultParams: {
		lookback: 20,
		threshold: 1.5,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Threshold",
	},
	normalizeParams: normalizeVolatilityClusteringParams,
	prepareFinderData: (data) => prepareVolatilityClusteringData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedVolatilityClusteringData(preparedData, data);
		const p = normalizeVolatilityClusteringParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let avgRange = prepared.avgRangeByLookback.get(lookback);
		if (!avgRange) {
			avgRange = buildRollingAverage(prepared.ranges, lookback);
			prepared.avgRangeByLookback.set(lookback, avgRange);
		}

		return createSignalLoop(prepared.data, [avgRange], (i) => {
			if (i < lookback) return null;
			const avg = avgRange[i];
			if (avg === null) return null;

			const currentRange = prepared.ranges[i];
			const cl = prepared.closeLocation[i];

			if (currentRange > threshold * avg && cl > 0.8) {
				return createBuySignal(prepared.data, i, `Range expansion (${currentRange.toFixed(4)} > ${(threshold * avg).toFixed(4)}) with close location ${cl.toFixed(2)}`);
			}
			if (currentRange > threshold * avg && cl < 0.2) {
				return createSellSignal(prepared.data, i, `Range expansion (${currentRange.toFixed(4)} > ${(threshold * avg).toFixed(4)}) with close location ${cl.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_volatility_clustering_breakout.executePrepared?.(prepareVolatilityClusteringData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
