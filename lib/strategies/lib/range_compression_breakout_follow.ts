import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

type RangeCompressionPrepared = {
	data: OHLCVData[];
	ranges: number[];
	closeLocation: number[];
	avgRangeByLookback: Map<number, (number | null)[]>;
	medianRangeByLookback: Map<number, (number | null)[]>;
};

function normalizeRangeCompressionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
	};
}

function prepareRangeCompressionData(data: OHLCVData[]): RangeCompressionPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		ranges: buildRangeSeries(clean),
		closeLocation: buildCloseLocationSeries(clean),
		avgRangeByLookback: new Map(),
		medianRangeByLookback: new Map(),
	};
}

function getPreparedRangeCompressionData(
	preparedData: unknown,
	data: OHLCVData[]
): RangeCompressionPrepared {
	if (preparedData && typeof preparedData === "object" && "avgRangeByLookback" in preparedData) {
		return preparedData as RangeCompressionPrepared;
	}
	return prepareRangeCompressionData(data);
}

export const range_compression_breakout_follow: Strategy = {
	name: "Range Compression Breakout Follow",
	description: "Chases breakouts when the current bar close location is extreme immediately following range compression.",
	defaultParams: {
		lookback: 30,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeRangeCompressionParams,
	prepareFinderData: (data) => prepareRangeCompressionData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedRangeCompressionData(preparedData, data);
		const p = normalizeRangeCompressionParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback + 1) return [];

		let avgRange = prepared.avgRangeByLookback.get(lookback);
		if (!avgRange) {
			avgRange = buildRollingAverage(prepared.ranges, lookback);
			prepared.avgRangeByLookback.set(lookback, avgRange);
		}

		let medianRange = prepared.medianRangeByLookback.get(lookback);
		if (!medianRange) {
			medianRange = buildRollingMedian(prepared.ranges, lookback);
			prepared.medianRangeByLookback.set(lookback, medianRange);
		}

		return createSignalLoop(prepared.data, [avgRange, medianRange], (i) => {
			if (i < lookback) return null;
			const prevAvg = avgRange[i - 1];
			const prevMed = medianRange[i - 1];
			if (prevAvg === null || prevMed === null) return null;

			const cl = prepared.closeLocation[i];

			if (prevAvg < prevMed && cl > 0.80) {
				return createBuySignal(prepared.data, i, `Compression breakout: prevAvgRange (${prevAvg.toFixed(4)}) < prevMedianRange (${prevMed.toFixed(4)}) with current close location (${cl.toFixed(2)}) > 0.80`);
			}
			if (prevAvg < prevMed && cl < 0.20) {
				return createSellSignal(prepared.data, i, `Compression breakdown: prevAvgRange (${prevAvg.toFixed(4)}) < prevMedianRange (${prevMed.toFixed(4)}) with current close location (${cl.toFixed(2)}) < 0.20`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_compression_breakout_follow.executePrepared?.(prepareRangeCompressionData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
